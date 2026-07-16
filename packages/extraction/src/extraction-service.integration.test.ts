import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { JobParser } from "../../contracts/src/index.js";
import type { OutboxDatabase } from "../../db/src/outbox.js";
import { DeterministicJobParser } from "../../parser/src/deterministic-job-parser.js";
import { MemoryRawObjectStore } from "../../storage/src/object-store.js";
import { ExtractionService } from "./extraction-service.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe.sequential;
const { Pool } = pg;

integration("Extraction replay and evidence persistence", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool }) });
  afterAll(async () => db.destroy());

  it("creates parser v2 beside v1, reuses v2, and preserves complete evidence", async () => {
    const sourceId = randomUUID();
    const recordId = randomUUID();
    const versionId = randomUUID();
    const storageKey = `raw/${versionId}`;
    const rawText = JSON.stringify({
      title: "27卒 Web Engineer",
      absolute_url: "https://example.com/jobs/27",
      location: { name: "Tokyo Remote" },
      content: "<p>雇用形態: 正社員 または 契約社員</p><p>JLPT N1 / TypeScript / React / AWS</p><p>Visa sponsorship is available. No visa sponsorship.</p><p>年収 400万円〜600万円</p>",
    });
    await sql`INSERT INTO source_instances(id, source_kind, tenant_key, base_url, verification_state)
      VALUES (${sourceId}::uuid, 'greenhouse', ${`extract-${sourceId}`}, 'https://boards-api.greenhouse.io', 'verified')`.execute(db);
    await sql`INSERT INTO source_job_records(id, source_instance_id, stable_key, canonical_url)
      VALUES (${recordId}::uuid, ${sourceId}::uuid, '27', 'https://example.com/jobs/27')`.execute(db);
    await sql`INSERT INTO source_job_versions(id, source_job_record_id, raw_hash, content_hash, canonicalization_version,
      raw_storage_key, raw_byte_length, source_url, fetched_at) VALUES (${versionId}::uuid, ${recordId}::uuid,
      ${"a".repeat(64)}, ${"b".repeat(64)}, 'json-stable-v1', ${storageKey}, ${rawText.length}, 'https://example.com/jobs/27', now())`.execute(db);
    const store = new MemoryRawObjectStore();
    await store.putIfAbsent(storageKey, new TextEncoder().encode(rawText), "application/json");
    const base = new DeterministicJobParser();
    const v2: JobParser = {
      parserKey: base.parserKey,
      parserVersion: "2.0.0",
      schemaVersion: base.schemaVersion,
      parse: (version, context) => base.parse(version, context),
    };
    const service = new ExtractionService(db, store);
    const v1Result = await service.extract(versionId, base);
    const v2Result = await service.extract(versionId, v2);
    const replay = await service.extract(versionId, v2);
    expect(v1Result).toMatchObject({ status: "succeeded", reused: false });
    expect(v2Result).toMatchObject({ status: "succeeded", reused: false });
    expect(replay).toMatchObject({ extractionId: v2Result.extractionId, status: "succeeded", reused: true });

    const counts = await sql<{ raw_versions: string; extractions: string; employment: string; skills: string;
      lineage: string; head: string }>`SELECT
      (SELECT count(*)::text FROM source_job_versions WHERE source_job_record_id = ${recordId}::uuid) raw_versions,
      (SELECT count(*)::text FROM source_job_extractions WHERE source_job_version_id = ${versionId}::uuid) extractions,
      (SELECT count(*)::text FROM extraction_employment_types WHERE extraction_id = ${v2Result.extractionId}::uuid) employment,
      (SELECT count(*)::text FROM extraction_skills WHERE extraction_id = ${v2Result.extractionId}::uuid) skills,
      (SELECT count(*)::text FROM source_job_extraction_lineage lineage
        JOIN source_job_extractions extraction ON extraction.id=lineage.extraction_id
        WHERE extraction.source_job_version_id=${versionId}::uuid) lineage,
      (SELECT extraction_id::text FROM source_job_extraction_heads
        WHERE source_job_record_id=${recordId}::uuid) head`.execute(db);
    expect(counts.rows[0]).toEqual({ raw_versions: "1", extractions: "2", employment: "2", skills: "3",
      lineage: "2", head: v2Result.extractionId });

    const missingEvidence = await sql<{ count: string }>`SELECT count(*)::text AS count
      FROM extraction_field_states f
      WHERE f.extraction_id = ${v2Result.extractionId}::uuid AND f.value_state <> 'unknown'
      AND NOT EXISTS (
        SELECT 1 FROM evidence e WHERE e.source_job_extraction_id = f.extraction_id
        AND e.field_path = CASE f.field_name
          WHEN 'employment_types' THEN 'employmentTypes'
          WHEN 'visa_sponsorship' THEN 'visaSupport'
          ELSE f.field_name END
      )`.execute(db);
    expect(missingEvidence.rows[0]?.count).toBe("0");
  });
});
