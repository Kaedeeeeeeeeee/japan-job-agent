import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { CanonicalService } from "../packages/canonical/src/canonical-service.js";
import { normalizeApplicationUrl } from "../packages/canonical/src/normalize-application-url.js";
import { PublicCareerConnector } from "../packages/connectors-public-career/src/public-career-connector.js";
import type { SourceInstanceRef } from "../packages/contracts/src/index.js";
import type { OutboxDatabase } from "../packages/db/src/outbox.js";
import { JobDiscoveryService } from "../packages/discovery/src/job-discovery-service.js";
import { verifyOfficialSourceBacklink } from "../packages/discovery/src/official-source-backlink-verifier.js";
import { ExtractionService } from "../packages/extraction/src/extraction-service.js";
import { SourceSyncService } from "../packages/ingestion/src/source-sync-service.js";
import { replaceWithAtomicFile } from "../packages/operations/src/atomic-file.js";
import { DeterministicJobParser } from "../packages/parser/src/deterministic-job-parser.js";
import { createObjectStore } from "./object-store-config.js";

interface CandidateRow {
  id: string;
  tenant_key: string;
  company_name: string;
  priority: "p0" | "p1" | "p2" | "p3";
  company_url: string | null;
}

interface TenantGroup {
  tenantKey: string;
  companyName: string;
  companyUrl: string | null;
  candidateIds: string[];
  counts: Record<"p0" | "p1" | "p2" | "p3", number>;
}

interface SeededSource {
  companyId: string;
  sourceInstanceId: string;
  relationshipId: string;
  evidenceId: string;
}

const databaseUrl = required("DATABASE_URL");
const targetActiveJobs = positiveInteger(process.env.PROMOTION_ACTIVE_TARGET, 2_000);
const maximumTenants = positiveInteger(process.env.PROMOTION_MAX_TENANTS, 1_000);
const hostIntervalMs = Math.max(1_000, positiveInteger(process.env.PROMOTION_HOST_INTERVAL_MS, 1_000));
const { Pool } = pg;
const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl }) }) });
const objectStore = createObjectStore();
const policyFetch = rateLimitedFetch(hostIntervalMs);
const connector = new PublicCareerConnector("talentio", policyFetch);
const parser = new DeterministicJobParser();
const discovery = new JobDiscoveryService(db);
const reports: Array<Record<string, unknown>> = [];

try {
  const groups = groupCandidates((await sql<CandidateRow>`SELECT c.id,c.tenant_key,c.company_name,c.priority,
      metadata.company_url
    FROM job_discovery_candidates c
    LEFT JOIN LATERAL (
      SELECT NULLIF(o.response_metadata->>'companyUrl','') company_url
      FROM job_discovery_observations o WHERE o.candidate_id=c.id
        AND o.response_metadata ? 'companyUrl' ORDER BY o.observed_at DESC,o.id DESC LIMIT 1
    ) metadata ON true
    WHERE c.source_family='talentio' AND c.tenant_key IS NOT NULL
      AND c.location_state='japan' AND c.state IN ('discovered','resolving','resolved','promoted')
    ORDER BY c.tenant_key,c.id`.execute(db)).rows).slice(0, maximumTenants);
  let activeJobs = await verifiedActiveCanonicalCount();
  let audited = 0;
  let verifiedTenants = 0;
  let queuedCandidates = 0;
  await drainPromotionQueue("talentio-promoter:recovery", 10_000);
  for (const group of groups) {
    if (activeJobs >= targetActiveJobs) break;
    audited += 1;
    const existing = await existingVerifiedSource(group.tenantKey);
    let source: SeededSource;
    let collectionUrl: string;
    if (existing !== null) {
      source = existing;
      collectionUrl = existing.baseUrl;
    } else {
      if (group.companyUrl === null) {
        await markResolutionPending(group.candidateIds, "corporate_url_missing");
        reports.push({ tenantKey: group.tenantKey, status: "corporate_url_missing", candidates: group.candidateIds.length });
        continue;
      }
      const verification = await verifyOfficialSourceBacklink(group.companyUrl, "talentio", group.tenantKey, policyFetch);
      if (!verification.verified || verification.detectedSource === null || verification.evidencePageUrl === null) {
        await markResolutionPending(group.candidateIds, verification.reason);
        reports.push({ tenantKey: group.tenantKey, status: verification.reason, candidates: group.candidateIds.length,
          auditedPages: verification.audits.length });
        continue;
      }
      collectionUrl = verification.detectedSource.url;
      source = await seedVerifiedRelationship(group, verification.corporateUrl, verification.evidencePageUrl, collectionUrl);
    }
    const sourceRef: SourceInstanceRef = { id: source.sourceInstanceId, sourceKind: "talentio",
      tenantKey: group.tenantKey, baseUrl: collectionUrl };
    try {
      const sync = await new SourceSyncService(db, connector, objectStore).run({ source: sourceRef,
        idempotencyKey: `talentio-promotion:${group.tenantKey}:${new Date().toISOString().slice(0, 10)}` },
      AbortSignal.timeout(6 * 60 * 60_000));
      const snapshot = sync.snapshot;
      const authoritative = snapshot?.kind === "authoritative" && snapshot.validation.parseErrors.length === 0;
      const currentJobs = snapshot?.jobs.length ?? await activeSourceJobCount(source.sourceInstanceId);
      if ((!sync.reused && !authoritative) || currentJobs === 0) {
        await markResolutionPending(group.candidateIds, "authoritative_sync_failed");
        reports.push({ tenantKey: group.tenantKey, status: "authoritative_sync_failed", currentJobs,
          snapshotKind: snapshot?.kind ?? null });
        continue;
      }
      await verifyPersistedSource(source);
      const materialized = await extractAndMaterialize(source.sourceInstanceId);
      const queued = await linkPromotedCandidates(group.tenantKey, source, group.candidateIds);
      queuedCandidates += queued;
      verifiedTenants += 1;
      activeJobs = await verifiedActiveCanonicalCount();
      reports.push({ tenantKey: group.tenantKey, status: "formalized", currentJobs, queued,
        extracted: materialized.extracted, canonicalized: materialized.canonicalized, activeJobs });
      process.stdout.write(`talentio promotion ${verifiedTenants} tenants, ${activeJobs}/${targetActiveJobs} active, ${group.tenantKey}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markResolutionPending(group.candidateIds, `promotion_error:${message.slice(0, 200)}`);
      reports.push({ tenantKey: group.tenantKey, status: "promotion_error", error: message });
    }
  }
  await drainPromotionQueue("talentio-promoter:fair-drain", 10_000);
  const promotedCandidates = (await sql<{ count: number }>`SELECT count(*)::int count
    FROM job_discovery_candidates WHERE source_family='talentio' AND state='promoted'`.execute(db)).rows[0]?.count ?? 0;
  const output = { generatedAt: new Date().toISOString(), targetActiveJobs, activeJobs, audited,
    verifiedTenants, queuedCandidates, promotedCandidates, reports };
  await replaceWithAtomicFile(path.resolve("tmp/talentio-promotion-report.json"), (temporaryPath) =>
    fs.writeFile(temporaryPath, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }));
  process.stdout.write(`${JSON.stringify({ targetActiveJobs, activeJobs, audited, verifiedTenants, promotedCandidates })}\n`);
} finally {
  await db.destroy();
}

function groupCandidates(rows: CandidateRow[]): TenantGroup[] {
  const groups = new Map<string, TenantGroup>();
  for (const row of rows) {
    const current = groups.get(row.tenant_key) ?? { tenantKey: row.tenant_key, companyName: row.company_name,
      companyUrl: row.company_url, candidateIds: [], counts: { p0: 0, p1: 0, p2: 0, p3: 0 } };
    current.candidateIds.push(row.id);
    current.counts[row.priority] += 1;
    if (current.companyUrl === null && row.company_url !== null) current.companyUrl = row.company_url;
    if (row.company_name.length > current.companyName.length) current.companyName = row.company_name;
    groups.set(row.tenant_key, current);
  }
  return fairTenantOrder([...groups.values()]);
}

function tenantScore(group: TenantGroup): number {
  return group.counts.p0 * 4 + group.counts.p1 * 3 + group.counts.p2 * 1.5 + group.counts.p3;
}

function fairTenantOrder(groups: TenantGroup[]): TenantGroup[] {
  const laneWeights = { technology: 0.5, consultHr: 0.25, other: 0.25 } as const;
  type Lane = keyof typeof laneWeights;
  const lanes = Map.groupBy(groups, tenantLane) as Map<Lane, TenantGroup[]>;
  for (const values of lanes.values()) values.sort((left, right) => tenantScore(right) - tenantScore(left)
    || right.candidateIds.length - left.candidateIds.length || left.tenantKey.localeCompare(right.tenantKey));
  const consumed: Record<Lane, number> = { technology: 0, consultHr: 0, other: 0 };
  const output: TenantGroup[] = [];
  while (output.length < groups.length) {
    const available = (["technology", "consultHr", "other"] as Lane[]).filter((lane) => (lanes.get(lane)?.length ?? 0) > 0);
    const lane = available.sort((left, right) => consumed[left] / laneWeights[left] - consumed[right] / laneWeights[right])[0];
    if (lane === undefined) break;
    const group = lanes.get(lane)!.shift()!;
    output.push(group);
    consumed[lane] += group.candidateIds.length;
  }
  return output;
}

function tenantLane(group: TenantGroup): "technology" | "consultHr" | "other" {
  const other = group.counts.p2 + group.counts.p3;
  if (group.counts.p0 >= group.counts.p1 && group.counts.p0 >= other) return "technology";
  return group.counts.p1 >= other ? "consultHr" : "other";
}

async function seedVerifiedRelationship(group: TenantGroup, corporateUrl: string, evidencePageUrl: string,
  collectionUrl: string): Promise<SeededSource> {
  const domain = new URL(corporateUrl).hostname.replace(/^www\./, "").toLowerCase();
  return db.transaction().execute(async (trx) => {
    const existingCompany = await sql<{ company_id: string }>`SELECT company_id FROM company_domains
      WHERE domain=${domain} AND is_official ORDER BY verified_at DESC NULLS LAST LIMIT 1`.execute(trx);
    const companyId = existingCompany.rows[0]?.company_id ?? randomUUID();
    await sql`INSERT INTO companies(id,legal_name,display_name,verification_state)
      VALUES (${companyId}::uuid,${group.companyName},${group.companyName},'verified')
      ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,verification_state='verified',updated_at=now()`.execute(trx);
    await sql`INSERT INTO company_domains(company_id,domain,is_official,verified_at,verification_note)
      VALUES (${companyId}::uuid,${domain},true,now(),'Corporate recruitment page backlink to exact Talentio tenant')
      ON CONFLICT(company_id,domain) DO UPDATE SET is_official=true,verified_at=now(),verification_note=excluded.verification_note`.execute(trx);
    const insertedSource = await sql<{ id: string }>`INSERT INTO source_instances(source_kind,tenant_key,base_url,verification_state)
      VALUES ('talentio',${group.tenantKey},${collectionUrl},'discovery')
      ON CONFLICT(source_kind,tenant_key) DO UPDATE SET base_url=excluded.base_url,updated_at=now() RETURNING id`.execute(trx);
    const sourceInstanceId = insertedSource.rows[0]!.id;
    await sql`INSERT INTO source_policies(source_instance_id,allows_authoritative_snapshot,terms_reviewed_at,policy_notes)
      VALUES (${sourceInstanceId}::uuid,true,now(),'Public Talentio sitemap and detail pages; 1 request/second host cap')
      ON CONFLICT(source_instance_id) DO UPDATE SET allows_authoritative_snapshot=true,terms_reviewed_at=now(),
        policy_notes=excluded.policy_notes,updated_at=now()`.execute(trx);
    const insertedRelationship = await sql<{ id: string }>`INSERT INTO company_source_relationships(company_id,source_instance_id,
        relationship_kind,valid_from,verification_state)
      VALUES (${companyId}::uuid,${sourceInstanceId}::uuid,'official_owner',now(),'discovery')
      ON CONFLICT(company_id,source_instance_id,relationship_kind,valid_to) DO UPDATE
        SET valid_from=LEAST(company_source_relationships.valid_from,excluded.valid_from) RETURNING id`.execute(trx);
    const relationshipId = insertedRelationship.rows[0]!.id;
    const locator = { corporateUrl, evidencePageUrl, collectionUrl, tenantKey: group.tenantKey,
      verifier: "official-source-backlink-v1" };
    const evidence = await sql<{ id: string }>`INSERT INTO evidence(kind,company_source_relationship_id,field_path,
        quoted_text,source_url,locator)
      SELECT 'ats_link',${relationshipId}::uuid,'company_source_relationship',
        ${`${group.companyName} official recruitment page links to Talentio tenant ${group.tenantKey}`},
        ${evidencePageUrl},${JSON.stringify(locator)}::jsonb
      WHERE NOT EXISTS(SELECT 1 FROM evidence WHERE company_source_relationship_id=${relationshipId}::uuid
        AND source_url=${evidencePageUrl} AND locator->>'tenantKey'=${group.tenantKey}) RETURNING id`.execute(trx);
    const evidenceId = evidence.rows[0]?.id ?? (await sql<{ id: string }>`SELECT id FROM evidence
      WHERE company_source_relationship_id=${relationshipId}::uuid AND source_url=${evidencePageUrl}
        AND locator->>'tenantKey'=${group.tenantKey} ORDER BY created_at DESC LIMIT 1`.execute(trx)).rows[0]?.id;
    if (evidenceId === undefined) throw new Error("Failed to persist Talentio relationship evidence");
    return { companyId, sourceInstanceId, relationshipId, evidenceId };
  });
}

async function existingVerifiedSource(tenantKey: string): Promise<(SeededSource & { baseUrl: string }) | null> {
  const result = await sql<SeededSource & { baseUrl: string }>`SELECT c.id "companyId",s.id "sourceInstanceId",
      csr.id "relationshipId",e.id "evidenceId",s.base_url "baseUrl"
    FROM source_instances s
    JOIN company_source_relationships csr ON csr.source_instance_id=s.id
      AND csr.verification_state='verified' AND csr.valid_to IS NULL
    JOIN companies c ON c.id=csr.company_id AND c.verification_state='verified'
    JOIN LATERAL (SELECT id FROM evidence WHERE company_source_relationship_id=csr.id ORDER BY created_at DESC LIMIT 1) e ON true
    WHERE s.source_kind='talentio' AND s.tenant_key=${tenantKey} AND s.verification_state='verified'
    LIMIT 1`.execute(db);
  return result.rows[0] ?? null;
}

async function verifyPersistedSource(source: SeededSource): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`UPDATE source_instances SET verification_state='verified',health_state='healthy',updated_at=now()
      WHERE id=${source.sourceInstanceId}::uuid`.execute(trx);
    await sql`UPDATE company_source_relationships SET verification_state='verified'
      WHERE id=${source.relationshipId}::uuid`.execute(trx);
    await sql`INSERT INTO source_job_company_attributions(source_job_record_id,company_source_relationship_id,valid_from)
      SELECT r.id,${source.relationshipId}::uuid,now() FROM source_job_records r
      WHERE r.source_instance_id=${source.sourceInstanceId}::uuid
      ON CONFLICT(source_job_record_id,company_source_relationship_id,valid_to) DO NOTHING`.execute(trx);
  });
}

async function extractAndMaterialize(sourceInstanceId: string): Promise<{ extracted: number; canonicalized: number }> {
  const versions = (await sql<{ id: string }>`SELECT v.id FROM source_job_versions v
    JOIN source_job_records r ON r.id=v.source_job_record_id
    WHERE r.source_instance_id=${sourceInstanceId}::uuid AND NOT EXISTS(
      SELECT 1 FROM source_job_extractions e WHERE e.source_job_version_id=v.id
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

async function linkPromotedCandidates(tenantKey: string, source: SeededSource, candidateIds: string[]): Promise<number> {
  const matches = (await sql<{ candidate_id: string; source_job_record_id: string; canonical_job_id: string; application_url: string }>`
    SELECT DISTINCT c.id candidate_id,r.id source_job_record_id,cjs.canonical_job_id,cv.application_url
    FROM job_discovery_candidates c
    JOIN source_job_records r ON r.source_instance_id=${source.sourceInstanceId}::uuid AND r.lifecycle_state='active'
      AND (r.external_id=c.external_posting_id OR r.stable_key=c.external_posting_id
        OR r.normalized_application_url=c.normalized_detail_url)
    JOIN canonical_job_sources cjs ON cjs.source_job_record_id=r.id AND cjs.active_to IS NULL
    JOIN canonical_jobs cj ON cj.id=cjs.canonical_job_id AND cj.lifecycle_state='active'
    JOIN canonical_job_versions cv ON cv.id=cj.current_version_id
    WHERE c.tenant_key=${tenantKey} AND c.state<>'promoted'
      AND c.id IN (${sql.join(candidateIds.map((id) => sql`${id}::uuid`))})`.execute(db)).rows;
  for (const match of matches) {
    const survivor = await discovery.applyResolution(match.candidate_id, { status: "resolved",
      officialUrl: match.application_url, sourceInstanceId: source.sourceInstanceId, evidenceIds: [source.evidenceId] });
    if (survivor !== match.candidate_id) continue;
    await discovery.enqueuePromotion(match.candidate_id, `talentio-promotion:${match.source_job_record_id}`);
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
          record.id source_job_record_id,link.canonical_job_id
        FROM job_discovery_candidates candidate
        JOIN source_job_records record ON record.source_instance_id=candidate.resolved_source_instance_id
          AND record.lifecycle_state='active' AND (
            record.external_id=candidate.external_posting_id OR record.stable_key=candidate.external_posting_id
            OR record.normalized_application_url=candidate.normalized_detail_url
            OR record.normalized_application_url=candidate.normalized_official_url)
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
  const result = await sql<{ count: number }>`SELECT count(DISTINCT cj.id)::int count FROM canonical_jobs cj
    JOIN canonical_job_sources cjs ON cjs.canonical_job_id=cj.id AND cjs.active_to IS NULL
    JOIN source_job_records r ON r.id=cjs.source_job_record_id AND r.lifecycle_state='active'
    JOIN source_instances s ON s.id=r.source_instance_id AND s.verification_state='verified'
    JOIN company_source_relationships csr ON csr.source_instance_id=s.id
      AND csr.verification_state='verified' AND csr.valid_to IS NULL
    WHERE cj.lifecycle_state='active'`.execute(db);
  return result.rows[0]?.count ?? 0;
}

async function activeSourceJobCount(sourceInstanceId: string): Promise<number> {
  return (await sql<{ count: number }>`SELECT count(*)::int count FROM source_job_records
    WHERE source_instance_id=${sourceInstanceId}::uuid AND lifecycle_state='active'`.execute(db)).rows[0]?.count ?? 0;
}

function rateLimitedFetch(intervalMs: number): typeof fetch {
  const nextByHost = new Map<string, number>();
  return async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const wait = Math.max(0, (nextByHost.get(url.hostname) ?? 0) - Date.now());
    if (wait > 0) await delay(wait);
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

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
