import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { OutboxDatabase } from "../../db/src/outbox.js";
import { CanonicalService } from "./canonical-service.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe.sequential;
const { Pool } = pg;

integration("Canonical strong-rule materialization", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool }) });
  afterAll(async () => db.destroy());

  it("merges normalized application URLs, switches primary by source priority, and can unmerge", async () => {
    const jobKey = randomUUID();
    const schema = await fixture(db, "schema_org", "Schema title", `https://example.com/jobs/${jobKey}/?utm_source=hrmos#apply`);
    const greenhouse = await fixture(db, "greenhouse", "Greenhouse title", `https://EXAMPLE.com/jobs/${jobKey}?utm_campaign=feed`);
    const service = new CanonicalService(db);
    const first = await service.materialize(schema.extractionId);
    const second = await service.materialize(greenhouse.extractionId);
    expect(first.mergedBy).toBe("new");
    expect(second).toMatchObject({ canonicalJobId: first.canonicalJobId, mergedBy: "application_url" });
    const primary = await sql<{ source_job_record_id: string }>`SELECT source_job_record_id FROM canonical_job_sources
      WHERE canonical_job_id=${first.canonicalJobId}::uuid AND source_role='primary' AND active_to IS NULL`.execute(db);
    expect(primary.rows[0]?.source_job_record_id).toBe(greenhouse.recordId);
    const inputs = await sql<{ primary_count: string; total: string }>`SELECT count(*) FILTER(WHERE input_role='primary')::text primary_count,
      count(*)::text total FROM canonical_materialization_inputs WHERE canonical_job_version_id=${second.canonicalJobVersionId}::uuid`.execute(db);
    expect(inputs.rows[0]).toEqual({ primary_count: "1", total: "2" });

    const newCanonicalId = await service.unmerge(greenhouse.recordId, "false positive merge review");
    expect(newCanonicalId).not.toBe(first.canonicalJobId);
    const links = await sql<{ canonical_job_id: string; source_job_record_id: string; source_role: string }>`SELECT canonical_job_id,
      source_job_record_id,source_role FROM canonical_job_sources WHERE active_to IS NULL
      AND canonical_job_id IN (${first.canonicalJobId}::uuid,${newCanonicalId}::uuid) ORDER BY canonical_job_id`.execute(db);
    expect(links.rows).toHaveLength(2);
    expect(links.rows.every((row) => row.source_role === "primary")).toBe(true);
    const event = await sql<{ count: string }>`SELECT count(*)::text count FROM canonical_merge_events
      WHERE source_job_record_id=${greenhouse.recordId}::uuid AND action='unmerge'`.execute(db);
    expect(event.rows[0]?.count).toBe("1");
  });

  it("never merges on title equality alone", async () => {
    const a = await fixture(db, "manual", "Same Engineer", `https://example.com/jobs/${randomUUID()}`);
    const b = await fixture(db, "manual", "Same Engineer", `https://example.com/jobs/${randomUUID()}`);
    const service = new CanonicalService(db);
    const first = await service.materialize(a.extractionId);
    const second = await service.materialize(b.extractionId);
    expect(second.mergedBy).toBe("new");
    expect(second.canonicalJobId).not.toBe(first.canonicalJobId);
  });

  it("merges an identical posting id only when both sources resolve to the same verified company", async () => {
    const a = await fixture(db, "manual", "Engineer A", `https://a.example.com/jobs/${randomUUID()}`);
    const b = await fixture(db, "manual", "Engineer B", `https://b.example.com/jobs/${randomUUID()}`);
    const companyId = randomUUID();
    await sql`UPDATE source_job_records SET external_id='REQ-2027-1' WHERE id IN (${a.recordId}::uuid,${b.recordId}::uuid)`.execute(db);
    await sql`INSERT INTO companies(id,legal_name,display_name,verification_state) VALUES
      (${companyId}::uuid,'Fixture Company','Fixture Company','verified')`.execute(db);
    await sql`INSERT INTO company_source_relationships(company_id,source_instance_id,relationship_kind,valid_from,verification_state) VALUES
      (${companyId}::uuid,${a.sourceId}::uuid,'official_owner',now(),'verified'),
      (${companyId}::uuid,${b.sourceId}::uuid,'official_owner',now(),'verified')`.execute(db);
    const service = new CanonicalService(db);
    const first = await service.materialize(a.extractionId);
    const second = await service.materialize(b.extractionId);
    expect(second).toMatchObject({ canonicalJobId: first.canonicalJobId, mergedBy: "posting_id" });
  });
});

async function fixture(
  db: Kysely<OutboxDatabase>,
  sourceKind: "greenhouse" | "schema_org" | "manual" | "hrmos" | "herp" | "jobcan",
  title: string,
  url: string,
): Promise<{ sourceId: string; recordId: string; extractionId: string }> {
  const sourceId = randomUUID();
  const recordId = randomUUID();
  const versionId = randomUUID();
  const extractionId = randomUUID();
  await sql`INSERT INTO source_instances(id,source_kind,tenant_key,base_url,verification_state)
    VALUES (${sourceId}::uuid,${sourceKind}::source_kind,${`canonical-${sourceId}`},'https://example.com','verified')`.execute(db);
  await sql`INSERT INTO source_job_records(id,source_instance_id,stable_key,canonical_url,external_id)
    VALUES (${recordId}::uuid,${sourceId}::uuid,${recordId},${url},${recordId})`.execute(db);
  await sql`INSERT INTO source_job_versions(id,source_job_record_id,raw_hash,content_hash,canonicalization_version,
    raw_storage_key,raw_byte_length,source_url,fetched_at) VALUES (${versionId}::uuid,${recordId}::uuid,
    ${"a".repeat(64)},${"b".repeat(64)},'fixture','raw/fixture',1,${url},now())`.execute(db);
  const structured = {
    title, descriptionText: title,
    employmentTypes: { state: "known", values: ["permanent"] }, visaSupport: { state: "unknown", values: [] },
    locations: { state: "known", values: [{ countryCode: "JP", addressText: "Tokyo" }] },
    languages: { state: "unknown", values: [] }, skills: { state: "known", values: [{ normalizedSkill: "typescript" }] },
    compensation: { state: "unknown", values: [] },
  };
  await sql`INSERT INTO source_job_extractions(id,source_job_version_id,parser_key,parser_version,schema_version,status,
    structured_result,extraction_hash,completed_at) VALUES (${extractionId}::uuid,${versionId}::uuid,'fixture','1','job-v1','succeeded',
    ${JSON.stringify(structured)}::jsonb,${"c".repeat(64)},now())`.execute(db);
  await sql`INSERT INTO evidence(kind,source_job_extraction_id,field_path,quoted_text,source_url,locator)
    VALUES ('field_quote',${extractionId}::uuid,'employmentTypes','正社員',${url},'{}'::jsonb)`.execute(db);
  return { sourceId, recordId, extractionId };
}
