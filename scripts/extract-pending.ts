import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { OutboxDatabase } from "../packages/db/src/outbox.js";
import { ExtractionService } from "../packages/extraction/src/extraction-service.js";
import { DeterministicJobParser } from "../packages/parser/src/deterministic-job-parser.js";
import { createObjectStore } from "./object-store-config.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
const limit = Number(process.argv[2] ?? 1_000);
if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("limit must be an integer from 1 to 10000");
const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl });
const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool }) });
try {
  const parser = new DeterministicJobParser();
  const pending = await sql<{ id: string; source_instance_id: string }>`SELECT v.id, s.id AS source_instance_id FROM source_job_versions v
    JOIN source_job_records r ON r.id=v.source_job_record_id
    JOIN source_instances s ON s.id=r.source_instance_id
    WHERE s.verification_state='verified' AND EXISTS (
      SELECT 1 FROM company_source_relationships csr WHERE csr.source_instance_id=s.id
      AND csr.verification_state='verified' AND csr.valid_to IS NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM source_job_extractions e WHERE e.source_job_version_id=v.id
      AND e.parser_key=${parser.parserKey} AND e.parser_version=${parser.parserVersion}
      AND e.schema_version=${parser.schemaVersion}
    ) ORDER BY v.fetched_at LIMIT ${limit}`.execute(db);
  const service = new ExtractionService(db, createObjectStore());
  let succeeded = 0;
  let failed = 0;
  let evidence = 0;
  for (const row of pending.rows) {
    try {
      const result = await service.extract(row.id, parser);
      if (result.status === "succeeded") succeeded += 1;
      else failed += 1;
      evidence += result.evidenceCount;
    } catch (error) {
      failed += 1;
      const detail = error instanceof Error ? error.message : String(error);
      await sql`INSERT INTO manual_review_tasks(source_instance_id, reason, detail)
        VALUES (${row.source_instance_id}::uuid, 'raw_object_missing_or_unreadable',
        ${JSON.stringify({ sourceJobVersionId: row.id, error: detail })}::jsonb)`.execute(db);
      process.stderr.write(`extraction failed for ${row.id}: ${detail}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify({ parserVersion: parser.parserVersion, selected: pending.rows.length, succeeded, failed, evidence })}\n`);
} finally {
  await db.destroy();
}
