import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { SchemaOrgConnector } from "../packages/connectors-schema-org/src/schema-org-connector.js";
import type { SourceInstanceRef } from "../packages/contracts/src/index.js";
import type { OutboxDatabase } from "../packages/db/src/outbox.js";
import { ExtractionService } from "../packages/extraction/src/extraction-service.js";
import { SourceSyncService } from "../packages/ingestion/src/source-sync-service.js";
import { DeterministicJobParser } from "../packages/parser/src/deterministic-job-parser.js";
import { createObjectStore } from "./object-store-config.js";

interface AuditResult {
  companyName: string;
  officialDomain: string;
  officialCareerUrl: string;
  jobUrl: string;
  tenantKey: string;
  auditedAt: string;
  officialLinkVerified: boolean;
  jobPostingVerified: boolean;
  status: "verified" | "failed";
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
const audit = JSON.parse(await fs.readFile(path.resolve("tmp/live-schema-org-audit.json"), "utf8")) as AuditResult[];
const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl });
const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool }) });
const store = createObjectStore();
try {
  for (const seed of audit) {
    if (seed.status !== "verified" || !seed.officialLinkVerified || !seed.jobPostingVerified) throw new Error(`${seed.tenantKey} is not verified`);
    if (Date.now() - new Date(seed.auditedAt).getTime() > 24 * 60 * 60 * 1_000) throw new Error(`${seed.tenantKey} audit is stale`);
    const { companyId, sourceInstanceId, relationshipId } = await seedRelationship(seed);
    const source: SourceInstanceRef = {
      id: sourceInstanceId, sourceKind: "schema_org", tenantKey: seed.tenantKey, baseUrl: new URL(seed.jobUrl).origin,
    };
    const sync = await new SourceSyncService(db, new SchemaOrgConnector(), store).run({
      source,
      idempotencyKey: `single:${new Date().toISOString().slice(0, 16)}`,
      recordIdentity: { sourceInstanceId, stableKey: seed.tenantKey, canonicalUrl: seed.jobUrl },
    });
    const version = await sql<{ id: string }>`SELECT v.id FROM source_job_versions v
      JOIN source_job_records r ON r.id = v.source_job_record_id
      WHERE r.source_instance_id = ${sourceInstanceId}::uuid ORDER BY v.fetched_at DESC LIMIT 1`.execute(db);
    const versionId = version.rows[0]?.id;
    if (versionId === undefined) throw new Error(`${seed.tenantKey} produced no raw version`);
    const extraction = await new ExtractionService(db, store).extract(versionId, new DeterministicJobParser());
    process.stdout.write(`${JSON.stringify({ tenantKey: seed.tenantKey, companyId, relationshipId,
      syncRunId: sync.syncRunId, snapshotKind: sync.snapshot?.kind ?? "reused", rawVersionId: versionId,
      extractionId: extraction.extractionId, extractionStatus: extraction.status, extractionReused: extraction.reused })}\n`);
  }
} finally {
  await db.destroy();
}

async function seedRelationship(seed: AuditResult): Promise<{ companyId: string; sourceInstanceId: string; relationshipId: string }> {
  return db.transaction().execute(async (trx) => {
    const company = await sql<{ id: string }>`SELECT id FROM companies WHERE legal_name = ${seed.companyName} ORDER BY created_at LIMIT 1`.execute(trx);
    const companyId = company.rows[0]?.id ?? randomUUID();
    if (company.rows[0] === undefined) await sql`INSERT INTO companies(id, legal_name, display_name, verification_state)
      VALUES (${companyId}::uuid, ${seed.companyName}, ${seed.companyName}, 'verified')`.execute(trx);
    await sql`INSERT INTO company_domains(company_id, domain, is_official, verified_at, verification_note)
      VALUES (${companyId}::uuid, ${seed.officialDomain}, true, ${seed.auditedAt}::timestamptz, 'Official career page linked HRMOS job')
      ON CONFLICT (company_id, domain) DO UPDATE SET is_official=true, verified_at=EXCLUDED.verified_at`.execute(trx);
    const source = await sql<{ id: string }>`INSERT INTO source_instances(source_kind, tenant_key, base_url, verification_state)
      VALUES ('schema_org', ${seed.tenantKey}, ${new URL(seed.jobUrl).origin}, 'verified')
      ON CONFLICT (source_kind, tenant_key) DO UPDATE SET verification_state='verified', updated_at=now() RETURNING id`.execute(trx);
    const sourceInstanceId = source.rows[0]?.id;
    if (sourceInstanceId === undefined) throw new Error("failed to seed schema source");
    await sql`INSERT INTO source_policies(source_instance_id, allows_authoritative_snapshot, terms_url, terms_reviewed_at, policy_notes)
      VALUES (${sourceInstanceId}::uuid, false, ${seed.officialCareerUrl}, ${seed.auditedAt}::timestamptz, 'Single-record schema.org source')
      ON CONFLICT (source_instance_id) DO UPDATE SET allows_authoritative_snapshot=false, updated_at=now()`.execute(trx);
    const existing = await sql<{ id: string }>`SELECT id FROM company_source_relationships WHERE company_id=${companyId}::uuid
      AND source_instance_id=${sourceInstanceId}::uuid AND relationship_kind='official_owner' AND valid_to IS NULL`.execute(trx);
    const relationshipId = existing.rows[0]?.id ?? randomUUID();
    if (existing.rows[0] === undefined) await sql`INSERT INTO company_source_relationships(id, company_id, source_instance_id,
      relationship_kind, valid_from, verification_state) VALUES (${relationshipId}::uuid, ${companyId}::uuid,
      ${sourceInstanceId}::uuid, 'official_owner', ${seed.auditedAt}::timestamptz, 'verified')`.execute(trx);
    const hasEvidence = await sql`SELECT 1 FROM evidence WHERE company_source_relationship_id=${relationshipId}::uuid
      AND source_url=${seed.officialCareerUrl}`.execute(trx);
    if (hasEvidence.rows[0] === undefined) await sql`INSERT INTO evidence(kind, company_source_relationship_id, field_path,
      quoted_text, source_url, locator) VALUES ('ats_link', ${relationshipId}::uuid, 'company_source_relationship',
      ${`${seed.companyName} official career page links ${seed.jobUrl}`}, ${seed.officialCareerUrl},
      ${JSON.stringify({ href: seed.jobUrl, auditedAt: seed.auditedAt })}::jsonb)`.execute(trx);
    return { companyId, sourceInstanceId, relationshipId };
  });
}
