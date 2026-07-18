import { randomUUID } from "node:crypto";
import { Connection, Client } from "@temporalio/client";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { CanonicalService } from "../packages/canonical/src/canonical-service.js";
import type { OutboxDatabase } from "../packages/db/src/outbox.js";
import { ExtractionService } from "../packages/extraction/src/extraction-service.js";
import { DeterministicJobParser } from "../packages/parser/src/deterministic-job-parser.js";
import { SourceExpansionStore } from "../packages/source-expansion/src/source-expansion-store.js";
import { sourceSyncWorkflow } from "../packages/workflows/src/source-sync-workflow.js";
import { createObjectStore } from "./object-store-config.js";

const apply = process.argv.includes("--apply");
if (process.argv.includes("--dry-run") && apply) throw new Error("Choose only one of --dry-run or --apply");
const { Pool } = pg;
const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: required("DATABASE_URL") }) }) });
const store = new SourceExpansionStore(db);
const parser = new DeterministicJobParser();
let runId: string | undefined;

try {
  const before = await debtCounts();
  if (!apply) {
    process.stdout.write(`${JSON.stringify({ mode: "dry-run", before }, null, 2)}\n`);
  } else {
    runId = await store.beginRun("quality_cleanup");
    const unverifiedHidden = await hideUnverifiedFormalJobs();
    const sources = await missingParserSourceIds();
    const resync = await resyncSources(sources);
    const extraction = await reparseLatestRaw();
    const parserQuarantined = await quarantineUnrecoverableParserDebt();
    const canonicalShellsDeleted = await deleteCanonicalShells();
    const after = await debtCounts();
    const counters = { unverifiedHidden, sourcesQueuedForResync: sources.length, resync,
      reparsed: extraction.reparsed, rematerialized: extraction.rematerialized,
      parserQuarantined, canonicalShellsDeleted, before, after };
    await store.finishRun(runId, "succeeded", counters, resync.errors);
    process.stdout.write(`${JSON.stringify({ mode: "apply", runId, ...counters }, null, 2)}\n`);
  }
} catch (error) {
  if (runId !== undefined) await store.finishRun(runId, "failed", {}, [error instanceof Error ? error.message : String(error)]);
  throw error;
} finally {
  await db.destroy();
}

async function debtCounts(): Promise<Record<string, number>> {
  const result = await sql<{ unverified_formal: number; current_parser_missing: number; canonical_shells: number }>`SELECT
    (SELECT count(*)::int FROM canonical_jobs job WHERE job.lifecycle_state='active' AND NOT EXISTS (
        SELECT 1 FROM canonical_job_sources link
        JOIN source_job_records record ON record.id=link.source_job_record_id AND record.lifecycle_state='active'
        JOIN source_instances source ON source.id=record.source_instance_id AND source.verification_state='verified'
        JOIN company_source_relationships relationship ON relationship.source_instance_id=source.id
          AND relationship.verification_state='verified' AND relationship.valid_to IS NULL
        JOIN evidence ON evidence.company_source_relationship_id=relationship.id
        WHERE link.canonical_job_id=job.id AND link.active_to IS NULL)) unverified_formal,
    (SELECT count(DISTINCT record.id)::int FROM source_job_records record
      JOIN source_instances source ON source.id=record.source_instance_id AND source.verification_state='verified'
      JOIN canonical_job_sources link ON link.source_job_record_id=record.id AND link.active_to IS NULL
      JOIN canonical_jobs job ON job.id=link.canonical_job_id AND job.lifecycle_state='active'
      WHERE record.lifecycle_state='active' AND NOT EXISTS(SELECT 1 FROM source_job_versions raw
        JOIN source_job_extractions extraction ON extraction.source_job_version_id=raw.id
          AND extraction.parser_key=${parser.parserKey} AND extraction.parser_version=${parser.parserVersion}
          AND extraction.schema_version=${parser.schemaVersion} AND extraction.status='succeeded'
        WHERE raw.source_job_record_id=record.id)) current_parser_missing,
    (SELECT count(*)::int FROM canonical_jobs WHERE current_version_id IS NULL) canonical_shells`.execute(db);
  return result.rows[0] ?? { unverified_formal: 0, current_parser_missing: 0, canonical_shells: 0 };
}

async function hideUnverifiedFormalJobs(): Promise<number> {
  const result = await sql<{ id: string }>`WITH targets AS (
      SELECT job.id FROM canonical_jobs job WHERE job.lifecycle_state='active' AND NOT EXISTS (
        SELECT 1 FROM canonical_job_sources link
        JOIN source_job_records record ON record.id=link.source_job_record_id AND record.lifecycle_state='active'
        JOIN source_instances source ON source.id=record.source_instance_id AND source.verification_state='verified'
        JOIN company_source_relationships relationship ON relationship.source_instance_id=source.id
          AND relationship.verification_state='verified' AND relationship.valid_to IS NULL
        JOIN evidence ON evidence.company_source_relationship_id=relationship.id
        WHERE link.canonical_job_id=job.id AND link.active_to IS NULL)
    ), audited AS (
      INSERT INTO source_quality_cleanup_audits(cleanup_kind,entity_kind,entity_id,before_state,after_state,reason)
      SELECT 'unverified_formal_hidden','canonical_job',job.id,
        jsonb_build_object('lifecycleState',job.lifecycle_state,'currentVersionId',job.current_version_id),
        jsonb_build_object('lifecycleState','suspect','currentVersionId',job.current_version_id),
        'No current verified official Company-Source relationship; removed from recommendation layer until verified'
      FROM canonical_jobs job JOIN targets ON targets.id=job.id ON CONFLICT DO NOTHING
    ) UPDATE canonical_jobs job SET lifecycle_state='suspect',updated_at=now() FROM targets
      WHERE job.id=targets.id RETURNING job.id`.execute(db);
  return result.rows.length;
}

async function missingParserSourceIds(): Promise<string[]> {
  const result = await sql<{ id: string }>`SELECT DISTINCT source.id FROM source_job_records record
    JOIN source_instances source ON source.id=record.source_instance_id AND source.verification_state='verified'
    JOIN canonical_job_sources link ON link.source_job_record_id=record.id AND link.active_to IS NULL
    JOIN canonical_jobs job ON job.id=link.canonical_job_id AND job.lifecycle_state='active'
    WHERE record.lifecycle_state='active' AND NOT EXISTS(SELECT 1 FROM source_job_versions raw
      JOIN source_job_extractions extraction ON extraction.source_job_version_id=raw.id
        AND extraction.parser_key=${parser.parserKey} AND extraction.parser_version=${parser.parserVersion}
        AND extraction.schema_version=${parser.schemaVersion} AND extraction.status='succeeded'
      WHERE raw.source_job_record_id=record.id) ORDER BY source.id`.execute(db);
  return result.rows.map((row) => row.id);
}

async function resyncSources(sourceIds: string[]): Promise<{ succeeded: number; failed: number; errors: string[] }> {
  if (sourceIds.length === 0) return { succeeded: 0, failed: 0, errors: [] };
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233" });
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default" });
  let succeeded = 0;
  let failed = 0;
  const errors: string[] = [];
  try {
    await mapWithConcurrency(sourceIds, 4, async (sourceId) => {
      try {
        const handle = await client.workflow.start(sourceSyncWorkflow, {
          taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "japan-job-agent",
          workflowId: `quality-resync-${sourceId}-${randomUUID()}`,
          args: [{ sourceInstanceId: sourceId }],
        });
        await handle.result();
        succeeded += 1;
      } catch (error) {
        failed += 1;
        errors.push(`${sourceId}:${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000));
      }
    });
  } finally {
    await connection.close();
  }
  return { succeeded, failed, errors };
}

async function reparseLatestRaw(): Promise<{ reparsed: number; rematerialized: number }> {
  const versions = (await sql<{ id: string }>`SELECT DISTINCT ON (record.id) raw.id FROM source_job_records record
    JOIN source_instances source ON source.id=record.source_instance_id AND source.verification_state='verified'
    JOIN canonical_job_sources link ON link.source_job_record_id=record.id AND link.active_to IS NULL
    JOIN canonical_jobs job ON job.id=link.canonical_job_id AND job.lifecycle_state='active'
    JOIN source_job_versions raw ON raw.source_job_record_id=record.id
    WHERE record.lifecycle_state='active' AND NOT EXISTS(SELECT 1 FROM source_job_versions candidate_raw
      JOIN source_job_extractions extraction ON extraction.source_job_version_id=candidate_raw.id
        AND extraction.parser_key=${parser.parserKey} AND extraction.parser_version=${parser.parserVersion}
        AND extraction.schema_version=${parser.schemaVersion} AND extraction.status='succeeded'
      WHERE candidate_raw.source_job_record_id=record.id)
    ORDER BY record.id,raw.fetched_at DESC,raw.id DESC`.execute(db)).rows;
  const extraction = new ExtractionService(db, createObjectStore());
  const canonical = new CanonicalService(db);
  let reparsed = 0;
  let rematerialized = 0;
  for (const version of versions) {
    try {
      const result = await extraction.extract(version.id, parser);
      if (result.status !== "succeeded") continue;
      reparsed += 1;
      await canonical.materialize(result.extractionId);
      rematerialized += 1;
    } catch {
      // The final query below quarantines records whose latest Raw object is still unavailable or unparsable.
    }
  }
  return { reparsed, rematerialized };
}

async function quarantineUnrecoverableParserDebt(): Promise<number> {
  const result = await sql<{ id: string }>`WITH targets AS (
      SELECT DISTINCT record.id,job.id canonical_job_id FROM source_job_records record
      JOIN source_instances source ON source.id=record.source_instance_id AND source.verification_state='verified'
      JOIN canonical_job_sources link ON link.source_job_record_id=record.id AND link.active_to IS NULL
      JOIN canonical_jobs job ON job.id=link.canonical_job_id AND job.lifecycle_state='active'
      WHERE record.lifecycle_state='active' AND NOT EXISTS(SELECT 1 FROM source_job_versions raw
        JOIN source_job_extractions extraction ON extraction.source_job_version_id=raw.id
          AND extraction.parser_key=${parser.parserKey} AND extraction.parser_version=${parser.parserVersion}
          AND extraction.schema_version=${parser.schemaVersion} AND extraction.status='succeeded'
        WHERE raw.source_job_record_id=record.id)
    ), audited AS (
      INSERT INTO source_quality_cleanup_audits(cleanup_kind,entity_kind,entity_id,before_state,after_state,reason)
      SELECT 'parser_quarantined','source_job_record',record.id,
        jsonb_build_object('recordLifecycle',record.lifecycle_state,'canonicalJobId',targets.canonical_job_id),
        jsonb_build_object('recordLifecycle','suspect','canonicalLifecycle','suspect'),
        'Current parser could not be recovered after authoritative resync and latest Raw replay'
      FROM source_job_records record JOIN targets ON targets.id=record.id ON CONFLICT DO NOTHING
    ), records AS (
      UPDATE source_job_records record SET lifecycle_state='suspect' FROM targets WHERE record.id=targets.id RETURNING record.id
    ) UPDATE canonical_jobs job SET lifecycle_state='suspect',updated_at=now() FROM targets
      WHERE job.id=targets.canonical_job_id RETURNING job.id`.execute(db);
  return result.rows.length;
}

async function deleteCanonicalShells(): Promise<number> {
  const result = await sql<{ id: string }>`WITH targets AS (
      SELECT id,lifecycle_state,created_at FROM canonical_jobs WHERE current_version_id IS NULL
    ), audited AS (
      INSERT INTO source_quality_cleanup_audits(cleanup_kind,entity_kind,entity_id,before_state,after_state,reason)
      SELECT 'canonical_shell_deleted','canonical_job',id,
        jsonb_build_object('lifecycleState',lifecycle_state,'currentVersionId',NULL,'createdAt',created_at),
        jsonb_build_object('deleted',true),'Canonical shell had no current materialized version'
      FROM targets ON CONFLICT DO NOTHING
    ) DELETE FROM canonical_jobs job USING targets WHERE job.id=targets.id RETURNING job.id`.execute(db);
  return result.rows.length;
}

async function mapWithConcurrency<T>(values: T[], concurrency: number, worker: (value: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) { const index = next; next += 1; await worker(values[index]!); }
  }));
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}
