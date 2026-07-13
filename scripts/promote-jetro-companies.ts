import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { CanonicalService } from "../packages/canonical/src/canonical-service.js";
import { HrmosConnector } from "../packages/connectors-hrmos/src/hrmos-connector.js";
import { PublicCareerConnector } from "../packages/connectors-public-career/src/public-career-connector.js";
import { SchemaOrgConnector } from "../packages/connectors-schema-org/src/schema-org-connector.js";
import type { SourceInstanceRef, SourceKind } from "../packages/contracts/src/index.js";
import type { OutboxDatabase } from "../packages/db/src/outbox.js";
import { detectSource, type DetectedRecruitmentSource, type RecruitmentEntrypointAudit } from "../packages/discovery/src/recruitment-entry-auditor.js";
import type { JetroOfpCompanyDetail } from "../packages/discovery/src/jetro-ofp.js";
import { ExtractionService } from "../packages/extraction/src/extraction-service.js";
import { SourceSyncService } from "../packages/ingestion/src/source-sync-service.js";
import { DeterministicJobParser } from "../packages/parser/src/deterministic-job-parser.js";
import { createObjectStore } from "./object-store-config.js";

interface DetailFile { auditedAt: string; details: JetroOfpCompanyDetail[] }
interface EntrypointRow { externalKey: string; displayName: string; officialSiteUrl: string | null; audit: RecruitmentEntrypointAudit }
interface EntrypointFile { auditedAt: string; results: EntrypointRow[] }
interface CandidateRow extends EntrypointRow { url: string }
interface CandidateFile { auditedAt: string; results: CandidateRow[] }
type SupportedKind = "hrmos" | "herp" | "jobcan" | "schema_org";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
const detailsFile = JSON.parse(await fs.readFile(path.resolve("tmp/jetro-ofp-company-details.json"), "utf8")) as DetailFile;
const entryFile = JSON.parse(await fs.readFile(path.resolve("tmp/recruitment-entrypoint-audits.json"), "utf8")) as EntrypointFile;
const candidateFile = JSON.parse(await fs.readFile(path.resolve("tmp/recruitment-candidate-audits.json"), "utf8")) as CandidateFile;
const auditKey = process.env.PROMOTION_AUDIT_KEY ?? `jetro-promotion:${detailsFile.auditedAt.slice(0, 10)}`;
const { Pool } = pg;
const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl }) }) });
const store = createObjectStore();
const entryByKey = new Map(entryFile.results.map((row) => [row.externalKey, row]));
const candidatesByKey = Map.groupBy(candidateFile.results, (row) => row.externalKey);
const promotedSourceIds = new Set<string>();
const summary = new Map<string, number>();

try {
  let completed = 0;
  for (const detail of detailsFile.details) {
    const entry = entryByKey.get(detail.externalKey);
    const candidateAudits = candidatesByKey.get(detail.externalKey) ?? [];
    const identity = await ensureCompany(detail, entry);
    const detected = aggregateSources(entry, candidateAudits).filter((source) => supported(source.kind));
    const unsupported = aggregateSources(entry, candidateAudits).filter((source) => !supported(source.kind));
    let currentJobs = 0;
    let activeSources = 0;
    const failures: string[] = [];
    for (const source of detected) {
      try {
        const result = await promoteSource(identity, detail, source);
        currentJobs += result.jobs;
        if (result.active) {
          activeSources += 1;
          promotedSourceIds.add(result.sourceInstanceId);
        }
      } catch (error) {
        failures.push(`${source.kind}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const status = activeSources > 0 ? "promoted_active"
      : entry === undefined || entry.audit.status !== "fetched" ? "unreachable"
      : entry.audit.transportSecure === false ? "insecure_source"
      : unsupported.length > 0 ? "unsupported_source"
      : entry.audit.candidateLinks.length > 0 ? "unstructured_career_page"
      : "verified_no_current_job";
    await persistPromotionAudit(identity, detail, entry, [...detected, ...unsupported], status, currentJobs, failures);
    summary.set(status, (summary.get(status) ?? 0) + 1);
    completed += 1;
    if (completed % 25 === 0 || completed === detailsFile.details.length) process.stdout.write(`promoted/audited ${completed}/${detailsFile.details.length}\n`);
  }

  const parser = new DeterministicJobParser();
  const extractionService = new ExtractionService(db, store);
  const canonicalService = new CanonicalService(db);
  const versions = promotedSourceIds.size === 0 ? [] : (await sql<{ id: string }>`SELECT v.id FROM source_job_versions v
    JOIN source_job_records r ON r.id=v.source_job_record_id WHERE r.source_instance_id = ANY(${[...promotedSourceIds]}::uuid[])
    AND NOT EXISTS(SELECT 1 FROM source_job_extractions e WHERE e.source_job_version_id=v.id
      AND e.parser_key=${parser.parserKey} AND e.parser_version=${parser.parserVersion} AND e.schema_version=${parser.schemaVersion})
    ORDER BY v.fetched_at`.execute(db)).rows;
  let extracted = 0;
  let canonicalized = 0;
  for (const version of versions) {
    const result = await extractionService.extract(version.id, parser);
    if (result.status !== "succeeded") continue;
    extracted += 1;
    await canonicalService.materialize(result.extractionId);
    canonicalized += 1;
  }
  process.stdout.write(`${JSON.stringify({ companies: detailsFile.details.length, statuses: Object.fromEntries(summary),
    promotedSources: promotedSourceIds.size, rawVersions: versions.length, extracted, canonicalized })}\n`);
} finally {
  await db.destroy();
}

async function ensureCompany(detail: JetroOfpCompanyDetail, entry: EntrypointRow | undefined): Promise<{ candidateId: string; companyId: string }> {
  return db.transaction().execute(async (trx) => {
    const candidate = await sql<{ id: string; linked_company_id: string | null }>`SELECT id,linked_company_id
      FROM company_discovery_candidates WHERE external_key=${detail.externalKey}
      AND discovery_source_id=(SELECT id FROM discovery_sources WHERE source_key='jetro-ofp')`.execute(trx);
    const row = candidate.rows[0];
    if (row === undefined) throw new Error(`Discovery candidate ${detail.externalKey} is missing; run discovery:jetro-ofp first`);
    const companyId = row.linked_company_id ?? randomUUID();
    const verification = entry?.audit.status === "fetched" ? "verified" : "discovery";
    await sql`INSERT INTO companies(id,legal_name,display_name,verification_state)
      VALUES (${companyId}::uuid,${detail.displayName},${detail.displayName},${verification}::verification_state)
      ON CONFLICT(id) DO UPDATE SET legal_name=excluded.legal_name,display_name=excluded.display_name,
        verification_state=excluded.verification_state,updated_at=now()`.execute(trx);
    await sql`UPDATE company_discovery_candidates SET linked_company_id=${companyId}::uuid,
      state=${verification === "verified" ? "verified" : "auditing"}::discovery_candidate_state,
      updated_at=now() WHERE id=${row.id}::uuid`.execute(trx);
    const domainUrl = detail.officialSiteUrl ?? (entry?.audit.finalUrl ?? detail.recruitmentUrl);
    if (domainUrl !== null && domainUrl !== undefined && !isRecruitmentPlatform(new URL(domainUrl).hostname)) {
      const domain = new URL(domainUrl).hostname.replace(/^www\./, "").toLowerCase();
      await sql`INSERT INTO company_domains(company_id,domain,is_official,verified_at,verification_note)
        VALUES (${companyId}::uuid,${domain},true,${detail.fetchedAt}::timestamptz,'JETRO OFP company-site link')
        ON CONFLICT(company_id,domain) DO UPDATE SET is_official=true,verified_at=excluded.verified_at,
          verification_note=excluded.verification_note`.execute(trx);
    }
    await insertDiscoveryEvidence(trx, row.id, "directory_recruitment_link", detail.detailUrl, detail.recruitmentUrl,
      `${detail.displayName} JETRO OFP detail links the public recruitment/contact entry`, detail.fetchedAt);
    if (detail.officialSiteUrl !== null) await insertDiscoveryEvidence(trx, row.id, "directory_company_site", detail.detailUrl,
      detail.officialSiteUrl, `${detail.displayName} JETRO OFP detail links the company website`, detail.fetchedAt);
    return { candidateId: row.id, companyId };
  });
}

async function promoteSource(identity: { candidateId: string; companyId: string }, detail: JetroOfpCompanyDetail,
  detected: DetectedRecruitmentSource): Promise<{ sourceInstanceId: string; jobs: number; active: boolean }> {
  const kind = detected.kind as SupportedKind;
  const tenantKey = kind === "schema_org" ? `jetro:${detail.externalKey}:${hash(detected.url)}` : detected.tenantKey;
  const baseUrl = kind === "schema_org" ? new URL(detected.url).origin : detected.url;
  const seeded = await db.transaction().execute(async (trx) => {
    const source = await sql<{ id: string }>`INSERT INTO source_instances(source_kind,tenant_key,base_url,verification_state)
      VALUES (${kind}::source_kind,${tenantKey},${baseUrl},'discovery')
      ON CONFLICT(source_kind,tenant_key) DO UPDATE SET base_url=excluded.base_url,updated_at=now() RETURNING id`.execute(trx);
    const sourceInstanceId = source.rows[0]?.id;
    if (sourceInstanceId === undefined) throw new Error("Failed to seed source instance");
    await sql`INSERT INTO source_policies(source_instance_id,allows_authoritative_snapshot,terms_reviewed_at,policy_notes)
      VALUES (${sourceInstanceId}::uuid,${kind !== "schema_org"},${detail.fetchedAt}::timestamptz,'JETRO expansion live audit')
      ON CONFLICT(source_instance_id) DO UPDATE SET allows_authoritative_snapshot=excluded.allows_authoritative_snapshot,
        terms_reviewed_at=excluded.terms_reviewed_at,policy_notes=excluded.policy_notes,updated_at=now()`.execute(trx);
    await sql`INSERT INTO source_discovery_candidates(company_discovery_candidate_id,source_kind,tenant_key,collection_url,
      official_referrer_url,state,detected_at) VALUES (${identity.candidateId}::uuid,${kind}::source_kind,${tenantKey},${detected.url},
      ${detail.recruitmentUrl},'discovered',${detail.fetchedAt}::timestamptz)
      ON CONFLICT(source_kind,tenant_key,collection_url) DO UPDATE SET official_referrer_url=excluded.official_referrer_url`.execute(trx);
    const relationship = await sql<{ id: string }>`INSERT INTO company_source_relationships(company_id,source_instance_id,
      relationship_kind,valid_from,verification_state) VALUES (${identity.companyId}::uuid,${sourceInstanceId}::uuid,'official_owner',
      ${detail.fetchedAt}::timestamptz,'discovery') ON CONFLICT(company_id,source_instance_id,relationship_kind,valid_to)
      DO UPDATE SET valid_from=LEAST(company_source_relationships.valid_from,excluded.valid_from) RETURNING id`.execute(trx);
    const relationshipId = relationship.rows[0]?.id;
    if (relationshipId === undefined) throw new Error("Failed to seed source relationship");
    await sql`INSERT INTO evidence(kind,company_source_relationship_id,field_path,quoted_text,source_url,locator)
      SELECT 'ats_link',${relationshipId}::uuid,'company_source_relationship',
        ${`${detail.displayName} public recruiting path resolves to ${detected.url}`},${detail.detailUrl},
        ${JSON.stringify({ recruitmentUrl: detail.recruitmentUrl, detectedUrl: detected.url, auditedAt: detail.fetchedAt })}::jsonb
      WHERE NOT EXISTS(SELECT 1 FROM evidence WHERE company_source_relationship_id=${relationshipId}::uuid
        AND source_url=${detail.detailUrl} AND locator->>'detectedUrl'=${detected.url})`.execute(trx);
    return { sourceInstanceId, relationshipId };
  });

  const source: SourceInstanceRef = { id: seeded.sourceInstanceId, sourceKind: kind as SourceKind, tenantKey, baseUrl };
  const connector = kind === "hrmos" ? new HrmosConnector()
    : kind === "schema_org" ? new SchemaOrgConnector()
    : new PublicCareerConnector(kind);
  const request = kind === "schema_org" ? {
    source, idempotencyKey: `${auditKey}:${hash(detected.url)}`,
    recordIdentity: { sourceInstanceId: source.id, stableKey: tenantKey, canonicalUrl: detected.url },
  } : { source, idempotencyKey: `${auditKey}:${hash(detected.url)}` };
  const result = await new SourceSyncService(db, connector, store).run(request);
  const persisted = await sql<{ jobs: number; verified: boolean }>`SELECT
    count(r.id)::int jobs,(s.verification_state='verified') verified FROM source_instances s
    LEFT JOIN source_job_records r ON r.source_instance_id=s.id AND r.lifecycle_state='active'
    WHERE s.id=${seeded.sourceInstanceId}::uuid GROUP BY s.verification_state`.execute(db);
  const jobs = result.snapshot?.jobs.length ?? persisted.rows[0]?.jobs ?? 0;
  const active = (result.snapshot !== null && ["authoritative", "single_record"].includes(result.snapshot.kind) && jobs > 0)
    || (result.reused && persisted.rows[0]?.verified === true && jobs > 0);
  if (active) await db.transaction().execute(async (trx) => {
    await sql`UPDATE source_instances SET verification_state='verified',health_state='healthy',updated_at=now()
      WHERE id=${seeded.sourceInstanceId}::uuid`.execute(trx);
    await sql`UPDATE company_source_relationships SET verification_state='verified' WHERE id=${seeded.relationshipId}::uuid`.execute(trx);
    await sql`UPDATE source_discovery_candidates SET state='verified',verified_at=now(),linked_source_instance_id=${seeded.sourceInstanceId}::uuid
      WHERE source_kind=${kind}::source_kind AND tenant_key=${tenantKey} AND collection_url=${detected.url}`.execute(trx);
  });
  return { sourceInstanceId: seeded.sourceInstanceId, jobs, active };
}

async function persistPromotionAudit(identity: { candidateId: string; companyId: string }, detail: JetroOfpCompanyDetail,
  entry: EntrypointRow | undefined, sources: DetectedRecruitmentSource[], status: string, currentJobs: number, failures: string[]): Promise<void> {
  await sql`INSERT INTO company_promotion_audits(company_discovery_candidate_id,audit_key,status,official_site_url,recruitment_url,
    final_recruitment_url,transport_secure,http_status,detected_sources,current_job_count,linked_company_id,detail,audited_at)
    VALUES (${identity.candidateId}::uuid,${auditKey},${status}::company_promotion_status,${detail.officialSiteUrl},${detail.recruitmentUrl},
      ${entry?.audit.finalUrl ?? null},${entry?.audit.transportSecure ?? null},${entry?.audit.httpStatus ?? null},
      ${JSON.stringify(sources)}::jsonb,${currentJobs},${identity.companyId}::uuid,
      ${JSON.stringify({ failures, entryStatus: entry?.audit.status ?? "missing" })}::jsonb,${detail.fetchedAt}::timestamptz)
    ON CONFLICT(company_discovery_candidate_id,audit_key) DO UPDATE SET status=excluded.status,
      official_site_url=excluded.official_site_url,recruitment_url=excluded.recruitment_url,
      final_recruitment_url=excluded.final_recruitment_url,transport_secure=excluded.transport_secure,
      http_status=excluded.http_status,detected_sources=excluded.detected_sources,current_job_count=excluded.current_job_count,
      linked_company_id=excluded.linked_company_id,detail=excluded.detail,audited_at=excluded.audited_at,updated_at=now()`.execute(db);
}

function aggregateSources(entry: EntrypointRow | undefined, candidates: CandidateRow[]): DetectedRecruitmentSource[] {
  const sources = new Map<string, DetectedRecruitmentSource>();
  const add = (source: DetectedRecruitmentSource | null) => {
    if (source === null) return;
    if (source.kind === "schema_org" && detectSource(source.url)?.kind === "hrmos") return;
    sources.set(`${source.kind}:${source.tenantKey}:${source.url}`, source);
  };
  if (entry !== undefined) {
    entry.audit.detectedSources.forEach(add);
    entry.audit.candidateLinks.map(detectSource).forEach(add);
  }
  for (const candidate of candidates) {
    candidate.audit.detectedSources.forEach(add);
    candidate.audit.candidateLinks.map(detectSource).forEach(add);
  }
  return [...sources.values()];
}

function supported(kind: string): kind is SupportedKind { return ["hrmos", "herp", "jobcan", "schema_org"].includes(kind); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 16); }
function isRecruitmentPlatform(host: string): boolean {
  return /(^|\.)(hrmos\.co|herp\.careers|jobcan\.jp|talentio\.com|en-gage\.net|wantedly\.com|arwrk\.net|jbplt\.jp)$/.test(host);
}

async function insertDiscoveryEvidence(trx: Parameters<Parameters<typeof db.transaction>[0]>[0], candidateId: string,
  type: string, sourceUrl: string, targetUrl: string | null, quote: string, observedAt: string): Promise<void> {
  await sql`INSERT INTO company_discovery_evidence(company_discovery_candidate_id,evidence_type,source_url,target_url,quoted_text,locator,observed_at)
    VALUES (${candidateId}::uuid,${type},${sourceUrl},${targetUrl},${quote},${JSON.stringify({ href: targetUrl })}::jsonb,${observedAt}::timestamptz)
    ON CONFLICT DO NOTHING`.execute(trx);
}
