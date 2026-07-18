import { createHash, randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { JobDiscoveryLead, SourceKind } from "../packages/contracts/src/index.js";
import type { OutboxDatabase } from "../packages/db/src/outbox.js";
import { JobDiscoveryService } from "../packages/discovery/src/job-discovery-service.js";
import {
  discoveryBackfillWindow,
  evaluateLeadForBackfill,
} from "../packages/freshness/src/discovery-backfill-window.js";

interface FormalJobRow {
  source_job_record_id: string;
  source_instance_id: string;
  source_kind: SourceKind;
  tenant_key: string;
  stable_key: string;
  external_id: string | null;
  canonical_url: string;
  first_seen_at: Date;
  last_seen_at: Date;
  canonical_job_id: string;
  title: string;
  application_url: string;
  structured_result: Record<string, unknown>;
  company_name: string;
  evidence_id: string;
  source_sync_run_id: string;
}

const databaseUrl = required("DATABASE_URL");
const backfillWindow = discoveryBackfillWindow(process.env.DISCOVERY_BACKFILL_DAYS);
const { Pool } = pg;
const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl }) }) });
const discovery = new JobDiscoveryService(db);

try {
  const discoverySourceId = await ensureDiscoverySource();
  const jobs = (await sql<FormalJobRow>`SELECT r.id source_job_record_id,s.id source_instance_id,s.source_kind,
      s.tenant_key,r.stable_key,r.external_id,r.canonical_url,r.first_seen_at,r.last_seen_at,
      cj.id canonical_job_id,cv.title,cv.application_url,cv.structured_result,c.display_name company_name,e.id evidence_id,
      authoritative_run.id source_sync_run_id
    FROM canonical_jobs cj
    JOIN canonical_job_versions cv ON cv.id=cj.current_version_id
    JOIN canonical_job_sources cjs ON cjs.canonical_job_id=cj.id AND cjs.active_to IS NULL AND cjs.source_role='primary'
    JOIN source_job_records r ON r.id=cjs.source_job_record_id AND r.lifecycle_state='active'
    JOIN source_instances s ON s.id=r.source_instance_id AND s.verification_state='verified'
    JOIN company_source_relationships csr ON csr.source_instance_id=s.id
      AND csr.verification_state='verified' AND csr.valid_to IS NULL
    JOIN companies c ON c.id=csr.company_id
    JOIN LATERAL (SELECT evidence.id FROM evidence WHERE evidence.company_source_relationship_id=csr.id
      ORDER BY evidence.created_at DESC,evidence.id LIMIT 1) e ON true
    JOIN LATERAL (SELECT run.id FROM source_sync_runs run WHERE run.source_instance_id=s.id
      AND run.status='succeeded' AND run.snapshot_kind='authoritative'
      ORDER BY run.finished_at DESC NULLS LAST,run.id DESC LIMIT 1) authoritative_run ON true
    WHERE cj.lifecycle_state='active'
    ORDER BY r.last_seen_at DESC,r.id`.execute(db)).rows;
  const importRuns = new Map<string, string>();
  for (const [sourceInstanceId, sourceJobs] of Map.groupBy(jobs, (job) => job.source_instance_id)) {
    const fingerprint = createHash("sha256").update(sourceJobs.map((job) => job.source_job_record_id).sort().join("\n")).digest("hex");
    importRuns.set(sourceInstanceId, await discovery.recordFinalizedAuthoritativeImport({
      discoverySourceId,
      idempotencyKey: `formal-source:${sourceInstanceId}:${sourceJobs[0]!.source_sync_run_id}:${fingerprint}`,
      pageCount: 1,
      providerTotal: sourceJobs.length,
      discoveredCount: sourceJobs.length,
      rawHash: fingerprint,
      validation: { allPagesCompleted: true, tenantIdentityConsistent: true, providerTotalMatched: true, parseErrors: [] },
    }));
  }
  let admitted = 0;
  let promoted = 0;
  let skippedUnknownLocation = 0;
  let skippedUnknownPublication = 0;
  let skippedOutsideWindow = 0;
  for (const job of jobs) {
    const locationText = locationFromStructured(job.structured_result);
    if (locationText === "") {
      skippedUnknownLocation += 1;
      continue;
    }
    const observedAt = job.last_seen_at.toISOString();
    const payload = JSON.stringify(job.structured_result);
    const published = publishedFromStructured(job.structured_result);
    const windowDecision = evaluateLeadForBackfill(
      published === undefined ? {} : { published },
      backfillWindow,
    );
    if (windowDecision !== null && !windowDecision.eligible) {
      if (windowDecision.reason === "publication_date_unknown") skippedUnknownPublication += 1;
      else skippedOutsideWindow += 1;
      continue;
    }
    const lead: JobDiscoveryLead = {
      discoverySourceId,
      originKind: "official_collection",
      sourceFamily: job.source_kind,
      sourceKindHint: job.source_kind,
      tenantKey: job.tenant_key,
      externalPostingId: job.external_id ?? job.stable_key,
      externalKey: `${job.source_kind}:${job.tenant_key}:${job.stable_key}`,
      detailUrl: job.canonical_url,
      officialUrl: job.application_url,
      companyName: job.company_name,
      title: job.title,
      locationText,
      priority: priorityForJob(`${job.title}\n${payload}`),
      ...(published === undefined ? {} : { published, rawPublishedText: published.value }),
      observationKey: `formal-backfill:${job.source_job_record_id}:${importRuns.get(job.source_instance_id)!}`,
      payloadHash: createHash("sha256").update(payload).digest("hex"),
      observedAt,
      authoritative: true,
      discoveryImportRunId: importRuns.get(job.source_instance_id)!,
      responseMetadata: { sourceJobRecordId: job.source_job_record_id, canonicalJobId: job.canonical_job_id },
    };
    const result = await discovery.ingest(lead);
    if (result.countable) admitted += 1;
    if (result.disposition !== "admitted") continue;
    await db.transaction().execute(async (trx) => {
      await sql`INSERT INTO job_discovery_resolution_evidence(candidate_id,evidence_id)
        VALUES (${result.candidateId}::uuid,${job.evidence_id}::uuid) ON CONFLICT DO NOTHING`.execute(trx);
      await sql`UPDATE job_discovery_candidates SET state='promoted',official_url=${job.application_url},
        normalized_official_url=${job.application_url},resolved_source_instance_id=${job.source_instance_id}::uuid,
        promoted_source_job_record_id=${job.source_job_record_id}::uuid,rejection_reason=NULL,updated_at=now()
        WHERE id=${result.candidateId}::uuid`.execute(trx);
      await sql`INSERT INTO job_promotion_attempts(id,candidate_id,idempotency_key,state,available_at,attempt_count,
          source_job_record_id,canonical_job_id,completed_at)
        VALUES (${randomUUID()}::uuid,${result.candidateId}::uuid,${`formal-backfill:${job.source_job_record_id}`},'succeeded',
          ${observedAt}::timestamptz,1,${job.source_job_record_id}::uuid,${job.canonical_job_id}::uuid,now())
        ON CONFLICT(candidate_id,idempotency_key) DO NOTHING`.execute(trx);
    });
    promoted += 1;
  }
  process.stdout.write(`${JSON.stringify({ formalJobs: jobs.length, admitted, promoted, skippedUnknownLocation,
    skippedUnknownPublication, skippedOutsideWindow,
    summary: await discovery.summary() })}\n`);
} finally {
  await db.destroy();
}

async function ensureDiscoverySource(): Promise<string> {
  const result = await sql<{ id: string }>`INSERT INTO discovery_sources(source_key,name,source_kind,base_url,policy_notes)
    VALUES ('formal-job-backfill','Existing verified formal job chain','official_career_site','https://localhost/',
      'Auditable bridge for jobs that completed Raw, Extraction, Evidence, Lifecycle and Canonical before job-level Discovery existed.')
    ON CONFLICT(source_key) DO UPDATE SET updated_at=now() RETURNING id`.execute(db);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("Failed to create formal job discovery source");
  return id;
}

function locationFromStructured(value: Record<string, unknown>): string {
  const locations = isObject(value.locations) && Array.isArray(value.locations.values) ? value.locations.values : [];
  return locations.flatMap((location) => isObject(location) && typeof location.addressText === "string"
    ? [location.addressText] : []).filter(Boolean).join(" / ");
}

function publishedFromStructured(value: Record<string, unknown>): JobDiscoveryLead["published"] {
  if (!isObject(value.jobDates) || !isObject(value.jobDates.published)
    || value.jobDates.published.state !== "known" || !Array.isArray(value.jobDates.published.values)) return undefined;
  const candidate = value.jobDates.published.values[0];
  if (!isObject(candidate) || typeof candidate.value !== "string"
    || (candidate.precision !== "date" && candidate.precision !== "datetime")) return undefined;
  return { value: candidate.value, precision: candidate.precision };
}

function priorityForJob(input: string): JobDiscoveryLead["priority"] {
  if (/software|engineer|developer|product|web|AI|machine learning|data|e.?commerce|IT|システム|エンジニア|開発|プロダクト/i.test(input)) return "p0";
  if (/consult|human resources|recruit|talent acquisition|people operations|人事|採用|コンサル/i.test(input)) return "p1";
  if (/介護|特定技能|specified skilled worker/i.test(input)) return "p3";
  return "p2";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}
