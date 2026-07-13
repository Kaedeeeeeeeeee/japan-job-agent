import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate.js";
import { claimOutboxEvents, consumeOnce, type OutboxDatabase } from "./outbox.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe.sequential;
const { Pool } = pg;

integration("PostgreSQL foundation invariants", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool }) });

  beforeAll(async () => {
    await migrate(databaseUrl);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("supports many companies per tenant and many tenants per company", async () => {
    const sourceA = randomUUID();
    const sourceB = randomUUID();
    const companyA = randomUUID();
    const companyB = randomUUID();
    await sql`INSERT INTO source_instances(id, source_kind, tenant_key, base_url) VALUES
      (${sourceA}::uuid, 'manual', ${`source-${sourceA}`}, 'https://example.com/a'),
      (${sourceB}::uuid, 'manual', ${`source-${sourceB}`}, 'https://example.com/b')`.execute(db);
    await sql`INSERT INTO companies(id, legal_name, display_name) VALUES
      (${companyA}::uuid, 'Company A', 'A'), (${companyB}::uuid, 'Company B', 'B')`.execute(db);
    await sql`INSERT INTO company_source_relationships(company_id, source_instance_id, relationship_kind, valid_from) VALUES
      (${companyA}::uuid, ${sourceA}::uuid, 'official_owner', now()),
      (${companyB}::uuid, ${sourceA}::uuid, 'official_recruiting_for', now()),
      (${companyA}::uuid, ${sourceB}::uuid, 'official_owner', now())`.execute(db);
    const bySource = await sql<{ count: string }>`SELECT count(*)::text AS count FROM company_source_relationships WHERE source_instance_id = ${sourceA}::uuid`.execute(db);
    const byCompany = await sql<{ count: string }>`SELECT count(*)::text AS count FROM company_source_relationships WHERE company_id = ${companyA}::uuid`.execute(db);
    expect(bySource.rows[0]?.count).toBe("2");
    expect(byCompany.rows[0]?.count).toBe("2");
  });

  it("round-trips multivalue employment, visa, salary, and conflicting field state", async () => {
    const ids = await createExtraction(db);
    const evidenceA = await createEvidence(db, ids.extractionId, "正社員 / 契約社員");
    const evidenceB = await createEvidence(db, ids.extractionId, "試用期間中は月給30万円");
    await sql`INSERT INTO extraction_field_states(extraction_id, field_name, value_state) VALUES
      (${ids.extractionId}::uuid, 'employment_types', 'conflicting'),
      (${ids.extractionId}::uuid, 'visa_transfer', 'known')`.execute(db);
    await sql`INSERT INTO extraction_employment_types(extraction_id, employment_type, evidence_id) VALUES
      (${ids.extractionId}::uuid, 'permanent', ${evidenceA}::uuid),
      (${ids.extractionId}::uuid, 'fixed_term', ${evidenceA}::uuid)`.execute(db);
    await sql`INSERT INTO extraction_residence_statuses(extraction_id, residence_status, evidence_id) VALUES
      (${ids.extractionId}::uuid, 'engineer_specialist_humanities_international_services', ${evidenceA}::uuid)`.execute(db);
    await sql`INSERT INTO extraction_compensation(extraction_id, compensation_kind, currency, period, minimum_amount, maximum_amount, is_calculated, evidence_id)
      VALUES (${ids.extractionId}::uuid, 'trial', 'JPY', 'month', 300000, 300000, false, ${evidenceB}::uuid)`.execute(db);
    await sql`INSERT INTO extraction_mobility_facts(extraction_id, visa_transfer_state, relocation_support_state, relocation_required_state, transfer_required_state, visa_transfer)
      VALUES (${ids.extractionId}::uuid, 'known', 'unknown', 'unknown', 'unknown', true)`.execute(db);
    const result = await sql<{ employment: string[]; visa: string[]; trial: string; visa_transfer: boolean }>`
      SELECT array_agg(DISTINCT et.employment_type) AS employment,
             array_agg(DISTINCT rs.residence_status) AS visa,
             max(c.minimum_amount)::text AS trial,
             bool_or(m.visa_transfer) AS visa_transfer
      FROM extraction_employment_types et
      JOIN extraction_residence_statuses rs ON rs.extraction_id = et.extraction_id
      JOIN extraction_compensation c ON c.extraction_id = et.extraction_id
      JOIN extraction_mobility_facts m ON m.extraction_id = et.extraction_id
      WHERE et.extraction_id = ${ids.extractionId}::uuid`.execute(db);
    expect(result.rows[0]?.employment.sort()).toEqual(["fixed_term", "permanent"]);
    expect(result.rows[0]?.visa).toHaveLength(1);
    expect(result.rows[0]?.trial).toBe("300000.00");
    expect(result.rows[0]?.visa_transfer).toBe(true);
  });

  it("rejects a second active canonical primary source and materialization input", async () => {
    const first = await createExtraction(db);
    const second = await createExtraction(db);
    const canonicalJobId = randomUUID();
    const versionId = randomUUID();
    await sql`INSERT INTO canonical_jobs(id) VALUES (${canonicalJobId}::uuid)`.execute(db);
    await sql`INSERT INTO canonical_job_versions(id, canonical_job_id, materialization_version, title, application_url, structured_result, content_hash)
      VALUES (${versionId}::uuid, ${canonicalJobId}::uuid, 'v1', 'Engineer', 'https://example.com/apply', '{}'::jsonb, ${"c".repeat(64)})`.execute(db);
    await sql`INSERT INTO canonical_job_sources(canonical_job_id, source_job_record_id, source_role, merge_reason)
      VALUES (${canonicalJobId}::uuid, ${first.recordId}::uuid, 'primary', 'same application URL')`.execute(db);
    await expect(sql`INSERT INTO canonical_job_sources(canonical_job_id, source_job_record_id, source_role, merge_reason)
      VALUES (${canonicalJobId}::uuid, ${second.recordId}::uuid, 'primary', 'invalid second primary')`.execute(db)).rejects.toThrow();
    await sql`INSERT INTO canonical_materialization_inputs(canonical_job_version_id, source_job_extraction_id, input_role)
      VALUES (${versionId}::uuid, ${first.extractionId}::uuid, 'primary')`.execute(db);
    await expect(sql`INSERT INTO canonical_materialization_inputs(canonical_job_version_id, source_job_extraction_id, input_role)
      VALUES (${versionId}::uuid, ${second.extractionId}::uuid, 'primary')`.execute(db)).rejects.toThrow();
  });

  it("deduplicates sync and Temporal retry identities", async () => {
    const sourceId = randomUUID();
    await sql`INSERT INTO source_instances(id, source_kind, tenant_key, base_url) VALUES
      (${sourceId}::uuid, 'manual', ${`idem-${sourceId}`}, 'https://example.com')`.execute(db);
    await sql`INSERT INTO source_sync_runs(source_instance_id, idempotency_key) VALUES (${sourceId}::uuid, 'daily:2026-07-13')`.execute(db);
    await expect(sql`INSERT INTO source_sync_runs(source_instance_id, idempotency_key) VALUES (${sourceId}::uuid, 'daily:2026-07-13')`.execute(db)).rejects.toThrow();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const activityId = randomUUID();
    await sql`INSERT INTO temporal_activity_executions(activity_key, activity_type, temporal_workflow_id, temporal_run_id, temporal_activity_id, status)
      VALUES (${`key-${randomUUID()}`}, 'persist-job', ${workflowId}, ${runId}, ${activityId}, 'succeeded')`.execute(db);
    await expect(sql`INSERT INTO temporal_activity_executions(activity_key, activity_type, temporal_workflow_id, temporal_run_id, temporal_activity_id, status)
      VALUES (${`key-${randomUUID()}`}, 'persist-job', ${workflowId}, ${runId}, ${activityId}, 'succeeded')`.execute(db)).rejects.toThrow();
  });

  it("allows two publishers to claim an event only once and consumers to apply once", async () => {
    const eventId = randomUUID();
    await sql`UPDATE outbox_events SET published_at = now() WHERE published_at IS NULL`.execute(db);
    await sql`INSERT INTO outbox_events(id, aggregate_type, aggregate_id, event_type, payload, dedup_key)
      VALUES (${eventId}::uuid, 'source_job', ${randomUUID()}::uuid, 'job.observed', '{}'::jsonb, ${`event-${eventId}`})`.execute(db);
    const [a, b] = await Promise.all([
      claimOutboxEvents(db, "publisher-a", 1),
      claimOutboxEvents(db, "publisher-b", 1),
    ]);
    expect(a.length + b.length).toBe(1);
    let effects = 0;
    const first = await db.transaction().execute((trx) => consumeOnce(trx, "canonicalizer", eventId, async () => { effects += 1; }));
    const replay = await db.transaction().execute((trx) => consumeOnce(trx, "canonicalizer", eventId, async () => { effects += 1; }));
    expect(first).toBe(true);
    expect(replay).toBe(false);
    expect(effects).toBe(1);
  });

  it("persists an idempotent recommendation run and independent job workflow state", async () => {
    const extraction = await createExtraction(db);
    const canonicalJobId = randomUUID();
    const canonicalVersionId = randomUUID();
    const profileId = randomUUID();
    const profileVersionId = randomUUID();
    const runId = randomUUID();
    const runKey = randomUUID().replaceAll("-", "").repeat(2);
    await sql`INSERT INTO canonical_jobs(id) VALUES (${canonicalJobId}::uuid)`.execute(db);
    await sql`INSERT INTO canonical_job_versions(id,canonical_job_id,materialization_version,title,application_url,structured_result,content_hash)
      VALUES (${canonicalVersionId}::uuid,${canonicalJobId}::uuid,'test','Engineer','https://example.com/apply','{}'::jsonb,${randomUUID().replaceAll("-", "").repeat(2)})`.execute(db);
    await sql`INSERT INTO profiles(id,profile_key) VALUES (${profileId}::uuid,${`test-${profileId}`})`.execute(db);
    await sql`INSERT INTO profile_versions(id,profile_id,version,schema_version,structured_profile,source_fingerprint)
      VALUES (${profileVersionId}::uuid,${profileId}::uuid,1,'profile-v1','{}'::jsonb,${"f".repeat(64)})`.execute(db);
    await sql`INSERT INTO recommendation_runs(id,user_key,run_key,profile_version_id,ranking_version,eligible_count,input_count)
      VALUES (${runId}::uuid,'github:test',${runKey},${profileVersionId}::uuid,'test-v1',1,1)`.execute(db);
    await sql`INSERT INTO recommendation_results(recommendation_run_id,canonical_job_id,canonical_job_version_id,rank,score,eligible,score_breakdown,explanation)
      VALUES (${runId}::uuid,${canonicalJobId}::uuid,${canonicalVersionId}::uuid,1,83,true,'[]'::jsonb,'{}'::jsonb)`.execute(db);
    await expect(sql`INSERT INTO recommendation_runs(user_key,run_key,profile_version_id,ranking_version,eligible_count,input_count)
      VALUES ('github:test',${runKey},${profileVersionId}::uuid,'test-v1',1,1)`.execute(db)).rejects.toThrow();
    await sql`INSERT INTO job_user_states(user_key,canonical_job_id,saved) VALUES ('github:test',${canonicalJobId}::uuid,true)
      ON CONFLICT(user_key,canonical_job_id) DO UPDATE SET saved=excluded.saved`.execute(db);
    await sql`INSERT INTO job_user_states(user_key,canonical_job_id,applied_at) VALUES ('github:test',${canonicalJobId}::uuid,now())
      ON CONFLICT(user_key,canonical_job_id) DO UPDATE SET applied_at=excluded.applied_at`.execute(db);
    const state = await sql<{ saved: boolean; applied: boolean }>`SELECT saved,applied_at IS NOT NULL applied FROM job_user_states
      WHERE user_key='github:test' AND canonical_job_id=${canonicalJobId}::uuid`.execute(db);
    expect(state.rows[0]).toEqual({ saved: true, applied: true });
    expect(extraction.recordId).toBeTruthy();
  });
});

async function createExtraction(db: Kysely<OutboxDatabase>): Promise<{ recordId: string; extractionId: string }> {
  const sourceId = randomUUID();
  const recordId = randomUUID();
  const versionId = randomUUID();
  const extractionId = randomUUID();
  await sql`INSERT INTO source_instances(id, source_kind, tenant_key, base_url) VALUES
    (${sourceId}::uuid, 'manual', ${`fixture-${sourceId}`}, 'https://example.com')`.execute(db);
  await sql`INSERT INTO source_job_records(id, source_instance_id, stable_key, canonical_url) VALUES
    (${recordId}::uuid, ${sourceId}::uuid, ${`job-${recordId}`}, 'https://example.com/job')`.execute(db);
  await sql`INSERT INTO source_job_versions(id, source_job_record_id, raw_hash, content_hash, canonicalization_version, raw_storage_key, raw_byte_length, source_url, fetched_at)
    VALUES (${versionId}::uuid, ${recordId}::uuid, ${"a".repeat(64)}, ${"b".repeat(64)}, 'fixture-v1', ${`raw/${versionId}`}, 2, 'https://example.com/job', now())`.execute(db);
  await sql`INSERT INTO source_job_extractions(id, source_job_version_id, parser_key, parser_version, schema_version, status, extraction_hash, completed_at)
    VALUES (${extractionId}::uuid, ${versionId}::uuid, 'fixture', '1', 'job-v1', 'succeeded', ${"d".repeat(64)}, now())`.execute(db);
  return { recordId, extractionId };
}

async function createEvidence(db: Kysely<OutboxDatabase>, extractionId: string, quote: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO evidence(id, kind, source_job_extraction_id, field_path, quoted_text, source_url, locator)
    VALUES (${id}::uuid, 'field_quote', ${extractionId}::uuid, 'fixture', ${quote}, 'https://example.com/job', '{"selector":"body"}'::jsonb)`.execute(db);
  return id;
}
