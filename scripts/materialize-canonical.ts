import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { CanonicalService } from "../packages/canonical/src/canonical-service.js";
import type { OutboxDatabase } from "../packages/db/src/outbox.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
const limit = Number(process.argv[2] ?? 2_000);
const { Pool } = pg;
const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl }) }) });
try {
  const pending = await sql<{ extraction_id: string }>`SELECT DISTINCT ON (r.id) e.id AS extraction_id
    FROM source_job_records r JOIN source_job_versions v ON v.source_job_record_id=r.id
    JOIN source_job_extractions e ON e.source_job_version_id=v.id
    JOIN source_instances s ON s.id=r.source_instance_id
    WHERE e.status='succeeded' AND r.lifecycle_state='active' AND s.verification_state='verified'
    AND EXISTS (SELECT 1 FROM company_source_relationships csr WHERE csr.source_instance_id=s.id
      AND csr.verification_state='verified' AND csr.valid_to IS NULL)
    ORDER BY r.id,e.completed_at DESC LIMIT ${limit}`.execute(db);
  const service = new CanonicalService(db);
  let created = 0;
  let reused = 0;
  const mergeRules: Record<string, number> = {};
  for (const row of pending.rows) {
    const result = await service.materialize(row.extraction_id);
    if (result.versionCreated) created += 1;
    else reused += 1;
    mergeRules[result.mergedBy] = (mergeRules[result.mergedBy] ?? 0) + 1;
  }
  process.stdout.write(`${JSON.stringify({ selected: pending.rows.length, versionsCreated: created, versionsReused: reused, mergeRules })}\n`);
} finally {
  await db.destroy();
}

