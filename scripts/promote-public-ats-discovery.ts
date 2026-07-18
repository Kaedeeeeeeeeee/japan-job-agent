import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { CanonicalService } from "../packages/canonical/src/canonical-service.js";
import {
  AshbyConnector,
  LeverConnector,
  SmartRecruitersConnector,
} from "../packages/connectors-public-ats/src/public-ats-connectors.js";
import { WorkdayConnector } from "../packages/connectors-workday/src/workday-connector.js";
import type {
  CollectionPage,
  CollectionPageRequest,
  SourceConnector,
  SourceInstanceRef,
  SourceJobIdentity,
} from "../packages/contracts/src/index.js";
import type { OutboxDatabase } from "../packages/db/src/outbox.js";
import { JobDiscoveryService } from "../packages/discovery/src/job-discovery-service.js";
import { verifyOfficialSourceBacklink } from "../packages/discovery/src/official-source-backlink-verifier.js";
import { publicAtsBaseUrl, type PublicAtsTenantSeed } from "../packages/discovery/src/public-ats-discovery.js";
import { ExtractionService } from "../packages/extraction/src/extraction-service.js";
import { SourceSyncService } from "../packages/ingestion/src/source-sync-service.js";
import { replaceWithAtomicFile } from "../packages/operations/src/atomic-file.js";
import { DeterministicJobParser } from "../packages/parser/src/deterministic-job-parser.js";
import { discoveryBackfillWindow } from "../packages/freshness/src/discovery-backfill-window.js";
import { createObjectStore } from "./object-store-config.js";

interface CandidateRow {
  id: string;
  external_posting_id: string;
  company_name: string;
}

interface SeededSource {
  sourceInstanceId: string;
  relationshipId: string;
  evidenceId: string;
}

const databaseUrl = required("DATABASE_URL");
const targetActiveJobs = positiveInteger(process.env.PROMOTION_ACTIVE_TARGET, 2_000);
const hostIntervalMs = Math.max(1_000, positiveInteger(process.env.PROMOTION_HOST_INTERVAL_MS, 1_000));
const backfillWindow = discoveryBackfillWindow(process.env.DISCOVERY_BACKFILL_DAYS);
const { Pool } = pg;
const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl }) }) });
const objectStore = createObjectStore();
const policyFetch = rateLimitedFetch(hostIntervalMs);
const parser = new DeterministicJobParser();
const discovery = new JobDiscoveryService(db);
const reports: Array<Record<string, unknown>> = [];

try {
  const seeds = (JSON.parse(await fs.readFile(path.resolve(
    process.env.PUBLIC_ATS_TENANT_FILE ?? "config/public-ats-tenant-seeds.json",
  ), "utf8")) as PublicAtsTenantSeed[]).filter((seed) => seed.officialReferrerUrl !== undefined);
  let activeJobs = await verifiedActiveCanonicalCount();
  for (const seed of seeds) {
    if (activeJobs >= targetActiveJobs) break;
    const candidates = (await sql<CandidateRow>`SELECT id,external_posting_id,company_name
      FROM job_discovery_candidates WHERE source_family=${seed.kind} AND tenant_key=${seed.tenantKey}
        AND external_posting_id IS NOT NULL AND location_state='japan'
        AND state IN ('discovered','resolving','resolved','promoted')
        AND publication_freshness='recent'
        AND (${backfillWindow?.cutoffDate ?? null}::date IS NULL OR
          COALESCE(source_published_date,(source_published_at AT TIME ZONE 'Asia/Tokyo')::date)
            BETWEEN ${backfillWindow?.cutoffDate ?? null}::date AND ${backfillWindow?.today ?? null}::date)
      ORDER BY id`.execute(db)).rows;
    if (candidates.length === 0) {
      reports.push({ kind: seed.kind, tenantKey: seed.tenantKey, status: "no_japan_candidates" });
      continue;
    }
    const verification = await verifyOfficialSourceBacklink(
      seed.officialReferrerUrl!, seed.kind, seed.tenantKey, policyFetch,
    );
    if (!verification.verified || verification.evidencePageUrl === null || verification.detectedSource === null) {
      await markResolutionPending(candidates.map((candidate) => candidate.id), verification.reason);
      reports.push({ kind: seed.kind, tenantKey: seed.tenantKey, status: verification.reason,
        candidates: candidates.length, auditedPages: verification.audits.length });
      continue;
    }
    const source = await seedVerifiedRelationship(seed, candidates[0]!.company_name,
      verification.corporateUrl, verification.evidencePageUrl, verification.detectedSource.url);
    const sourceRef: SourceInstanceRef = { id: source.sourceInstanceId, sourceKind: seed.kind,
      tenantKey: seed.tenantKey, baseUrl: publicAtsBaseUrl(seed.kind, seed.tenantKey) };
    try {
      const allowedIds = new Set(candidates.map((candidate) => candidate.external_posting_id));
      const connector = candidateSubsetConnector(connectorFor(seed.kind, policyFetch), allowedIds);
      const fingerprint = createHash("sha256").update([...allowedIds].sort().join("\n")).digest("hex").slice(0, 16);
      const sync = await new SourceSyncService(db, connector, objectStore).run({ source: sourceRef,
        idempotencyKey: `public-ats-promotion:${seed.kind}:${seed.tenantKey}:${new Date().toISOString().slice(0, 10)}:${fingerprint}` },
      AbortSignal.timeout(6 * 60 * 60_000));
      const authoritative = sync.snapshot?.kind === "authoritative"
        && sync.snapshot.validation.parseErrors.length === 0;
      const currentJobs = sync.snapshot?.jobs.length ?? 0;
      if ((!sync.reused && !authoritative) || currentJobs === 0) {
        await markResolutionPending(candidates.map((candidate) => candidate.id), "authoritative_sync_failed");
        reports.push({ kind: seed.kind, tenantKey: seed.tenantKey, status: "authoritative_sync_failed",
          snapshotKind: sync.snapshot?.kind ?? null, currentJobs });
        continue;
      }
      await verifyPersistedSource(source);
      const materialized = await extractAndMaterialize(source.sourceInstanceId);
      const queued = await linkCandidates(seed, source, candidates);
      await drainPromotionQueue(`public-ats-promoter:${seed.kind}:${seed.tenantKey}`, 10_000);
      activeJobs = await verifiedActiveCanonicalCount();
      reports.push({ kind: seed.kind, tenantKey: seed.tenantKey, status: "formalized", currentJobs, queued,
        extracted: materialized.extracted, canonicalized: materialized.canonicalized, activeJobs });
      process.stdout.write(`public ATS promotion ${seed.kind}:${seed.tenantKey}, ${activeJobs}/${targetActiveJobs} active\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markResolutionPending(candidates.map((candidate) => candidate.id), `promotion_error:${message.slice(0, 200)}`);
      reports.push({ kind: seed.kind, tenantKey: seed.tenantKey, status: "promotion_error", error: message });
    }
  }
  const output = { generatedAt: new Date().toISOString(), targetActiveJobs, activeJobs, reports };
  await replaceWithAtomicFile(path.resolve("tmp/public-ats-promotion-report.json"), (temporaryPath) =>
    fs.writeFile(temporaryPath, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }));
  process.stdout.write(`${JSON.stringify({ targetActiveJobs, activeJobs, audited: reports.length })}\n`);
} finally {
  await db.destroy();
}

function candidateSubsetConnector(inner: SourceConnector, allowedIds: ReadonlySet<string>): SourceConnector {
  return {
    kind: inner.kind,
    async fetchCollectionPage(request: CollectionPageRequest): Promise<CollectionPage> {
      const page = await inner.fetchCollectionPage(request);
      const { providerTotal: _providerTotal, ...withoutProviderTotal } = page;
      return { ...withoutProviderTotal,
        jobs: page.jobs.filter((job) => allowedIds.has(job.identity.externalId ?? job.identity.stableKey)) };
    },
    fetchRecord(identity: SourceJobIdentity, signal: AbortSignal) {
      return inner.fetchRecord(identity, signal);
    },
  };
}

function connectorFor(kind: PublicAtsTenantSeed["kind"], fetchImplementation: typeof fetch): SourceConnector {
  return kind === "smartrecruiters" ? new SmartRecruitersConnector(fetchImplementation)
    : kind === "lever" ? new LeverConnector(fetchImplementation)
      : kind === "ashby" ? new AshbyConnector(fetchImplementation)
        : new WorkdayConnector(fetchImplementation, 8 * 1024 * 1024, "Japan");
}

async function seedVerifiedRelationship(seed: PublicAtsTenantSeed, fallbackCompanyName: string, corporateUrl: string,
  evidencePageUrl: string, detectedSourceUrl: string): Promise<SeededSource> {
  const domain = new URL(corporateUrl).hostname.replace(/^www\./, "").toLowerCase();
  const displayName = seed.companyName ?? fallbackCompanyName;
  return db.transaction().execute(async (trx) => {
    const existingCompany = await sql<{ company_id: string }>`SELECT company_id FROM company_domains
      WHERE domain=${domain} AND is_official ORDER BY verified_at DESC NULLS LAST LIMIT 1`.execute(trx);
    const companyId = existingCompany.rows[0]?.company_id ?? randomUUID();
    await sql`INSERT INTO companies(id,legal_name,display_name,verification_state)
      VALUES (${companyId}::uuid,${displayName},${displayName},'verified')
      ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,verification_state='verified',updated_at=now()`.execute(trx);
    await sql`INSERT INTO company_domains(company_id,domain,is_official,verified_at,verification_note)
      VALUES (${companyId}::uuid,${domain},true,now(),'Corporate recruitment page backlink to exact public ATS tenant')
      ON CONFLICT(company_id,domain) DO UPDATE SET is_official=true,verified_at=now(),
        verification_note=excluded.verification_note`.execute(trx);
    const sourceId = (await sql<{ id: string }>`INSERT INTO source_instances(source_kind,tenant_key,base_url,verification_state)
      VALUES (${seed.kind},${seed.tenantKey},${publicAtsBaseUrl(seed.kind, seed.tenantKey)},'discovery')
      ON CONFLICT(source_kind,tenant_key) DO UPDATE SET base_url=excluded.base_url,updated_at=now() RETURNING id`.execute(trx)).rows[0]!.id;
    await sql`INSERT INTO source_policies(source_instance_id,allows_authoritative_snapshot,terms_reviewed_at,policy_notes)
      VALUES (${sourceId}::uuid,true,now(),'Public ATS API; Japan-filtered candidate subset; all provider pages consumed; 1 request/second host cap')
      ON CONFLICT(source_instance_id) DO UPDATE SET allows_authoritative_snapshot=true,terms_reviewed_at=now(),
        policy_notes=excluded.policy_notes,updated_at=now()`.execute(trx);
    const relationshipId = (await sql<{ id: string }>`INSERT INTO company_source_relationships(company_id,source_instance_id,
        relationship_kind,valid_from,verification_state)
      VALUES (${companyId}::uuid,${sourceId}::uuid,'official_owner',now(),'discovery')
      ON CONFLICT(company_id,source_instance_id,relationship_kind,valid_to) DO UPDATE SET valid_from=LEAST(
        company_source_relationships.valid_from,excluded.valid_from) RETURNING id`.execute(trx)).rows[0]!.id;
    const locator = { corporateUrl, evidencePageUrl, detectedSourceUrl, tenantKey: seed.tenantKey,
      verifier: "official-source-backlink-v1" };
    const inserted = await sql<{ id: string }>`INSERT INTO evidence(kind,company_source_relationship_id,field_path,
        quoted_text,source_url,locator)
      SELECT 'ats_link',${relationshipId}::uuid,'company_source_relationship',
        ${`${displayName} official recruitment page links to ${seed.kind} tenant ${seed.tenantKey}`},
        ${evidencePageUrl},${JSON.stringify(locator)}::jsonb
      WHERE NOT EXISTS(SELECT 1 FROM evidence WHERE company_source_relationship_id=${relationshipId}::uuid
        AND source_url=${evidencePageUrl} AND locator->>'tenantKey'=${seed.tenantKey}) RETURNING id`.execute(trx);
    const evidenceId = inserted.rows[0]?.id ?? (await sql<{ id: string }>`SELECT id FROM evidence
      WHERE company_source_relationship_id=${relationshipId}::uuid AND source_url=${evidencePageUrl}
        AND locator->>'tenantKey'=${seed.tenantKey} ORDER BY created_at DESC LIMIT 1`.execute(trx)).rows[0]?.id;
    if (evidenceId === undefined) throw new Error("Failed to persist public ATS relationship evidence");
    return { sourceInstanceId: sourceId, relationshipId, evidenceId };
  });
}

async function verifyPersistedSource(source: SeededSource): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`UPDATE source_instances SET verification_state='verified',health_state='healthy',updated_at=now()
      WHERE id=${source.sourceInstanceId}::uuid`.execute(trx);
    await sql`UPDATE company_source_relationships SET verification_state='verified'
      WHERE id=${source.relationshipId}::uuid`.execute(trx);
    await sql`INSERT INTO source_job_company_attributions(source_job_record_id,company_source_relationship_id,valid_from)
      SELECT id,${source.relationshipId}::uuid,now() FROM source_job_records
      WHERE source_instance_id=${source.sourceInstanceId}::uuid
      ON CONFLICT(source_job_record_id,company_source_relationship_id,valid_to) DO NOTHING`.execute(trx);
  });
}

async function extractAndMaterialize(sourceInstanceId: string): Promise<{ extracted: number; canonicalized: number }> {
  const versions = (await sql<{ id: string }>`SELECT v.id FROM source_job_versions v
    JOIN source_job_records r ON r.id=v.source_job_record_id WHERE r.source_instance_id=${sourceInstanceId}::uuid
      AND NOT EXISTS(SELECT 1 FROM source_job_extractions e WHERE e.source_job_version_id=v.id
        AND e.parser_key=${parser.parserKey} AND e.parser_version=${parser.parserVersion}
        AND e.schema_version=${parser.schemaVersion}) ORDER BY v.fetched_at,v.id`.execute(db)).rows;
  const extraction = new ExtractionService(db, objectStore);
  const canonical = new CanonicalService(db);
  let extracted = 0;
  let canonicalized = 0;
  for (const version of versions) {
    const result = await extraction.extract(version.id, parser);
    if (result.status !== "succeeded") continue;
    extracted += 1;
    await canonical.materialize(result.extractionId);
    canonicalized += 1;
  }
  return { extracted, canonicalized };
}

async function linkCandidates(seed: PublicAtsTenantSeed, source: SeededSource, candidates: CandidateRow[]): Promise<number> {
  const ids = candidates.map((candidate) => candidate.id);
  const matches = (await sql<{ candidate_id: string; source_job_record_id: string; application_url: string }>`SELECT
      candidate.id candidate_id,record.id source_job_record_id,version.application_url
    FROM job_discovery_candidates candidate
    JOIN source_job_records record ON record.source_instance_id=${source.sourceInstanceId}::uuid
      AND record.lifecycle_state='active' AND record.external_id=candidate.external_posting_id
    JOIN canonical_job_sources link ON link.source_job_record_id=record.id AND link.active_to IS NULL
    JOIN canonical_jobs job ON job.id=link.canonical_job_id AND job.lifecycle_state='active'
    JOIN canonical_job_versions version ON version.id=job.current_version_id
    WHERE candidate.source_family=${seed.kind} AND candidate.tenant_key=${seed.tenantKey}
      AND candidate.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`))})`.execute(db)).rows;
  for (const match of matches) {
    const survivor = await discovery.applyResolution(match.candidate_id, { status: "resolved",
      officialUrl: match.application_url, sourceInstanceId: source.sourceInstanceId, evidenceIds: [source.evidenceId] });
    if (survivor === match.candidate_id) {
      await discovery.enqueuePromotion(match.candidate_id, `public-ats-promotion:${match.source_job_record_id}`);
    }
  }
  return matches.length;
}

async function drainPromotionQueue(workerId: string, budget: number): Promise<void> {
  let processed = 0;
  while (processed < budget) {
    const claimed = await discovery.claimPromotionAttempts(workerId, Math.min(100, budget - processed), 30 * 60_000);
    if (claimed.length === 0) return;
    for (const attempt of claimed) {
      const formal = await sql<{ source_job_record_id: string; canonical_job_id: string }>`SELECT
          record.id source_job_record_id,link.canonical_job_id FROM job_discovery_candidates candidate
        JOIN source_job_records record ON record.source_instance_id=candidate.resolved_source_instance_id
          AND record.lifecycle_state='active' AND record.external_id=candidate.external_posting_id
        JOIN canonical_job_sources link ON link.source_job_record_id=record.id AND link.active_to IS NULL
        JOIN canonical_jobs job ON job.id=link.canonical_job_id AND job.lifecycle_state='active'
        WHERE candidate.id=${attempt.candidateId}::uuid LIMIT 1`.execute(db);
      const row = formal.rows[0];
      if (row === undefined) {
        await discovery.failPromotion(attempt.id, workerId, "formal_match", "Resolved candidate has no active formal match",
          new Date(Date.now() + 15 * 60_000));
      } else {
        await discovery.completePromotion(attempt.id, workerId, row.source_job_record_id, row.canonical_job_id);
      }
      processed += 1;
    }
  }
}

async function markResolutionPending(candidateIds: string[], reason: string): Promise<void> {
  if (candidateIds.length === 0) return;
  await sql`UPDATE job_discovery_candidates SET rejection_reason=${`resolution_pending:${reason}`},updated_at=now()
    WHERE id IN (${sql.join(candidateIds.map((id) => sql`${id}::uuid`))}) AND state IN ('discovered','resolving')`.execute(db);
}

async function verifiedActiveCanonicalCount(): Promise<number> {
  return (await sql<{ count: number }>`SELECT count(DISTINCT job.id)::int count FROM canonical_jobs job
    JOIN canonical_job_sources link ON link.canonical_job_id=job.id AND link.active_to IS NULL
    JOIN source_job_records record ON record.id=link.source_job_record_id AND record.lifecycle_state='active'
    JOIN source_instances source ON source.id=record.source_instance_id AND source.verification_state='verified'
    JOIN company_source_relationships relationship ON relationship.source_instance_id=source.id
      AND relationship.verification_state='verified' AND relationship.valid_to IS NULL
    WHERE job.lifecycle_state='active'`.execute(db)).rows[0]?.count ?? 0;
}

function rateLimitedFetch(intervalMs: number): typeof fetch {
  const nextByHost = new Map<string, number>();
  return async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const wait = Math.max(0, (nextByHost.get(url.hostname) ?? 0) - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    nextByHost.set(url.hostname, Date.now() + intervalMs);
    return fetch(input, init);
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected positive integer, received ${value}`);
  return parsed;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}
