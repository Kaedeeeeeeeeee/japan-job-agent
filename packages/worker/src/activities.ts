import { randomUUID } from "node:crypto";
import { activityInfo, ApplicationFailure } from "@temporalio/activity";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { CanonicalService } from "../../canonical/src/canonical-service.js";
import { GreenhouseConnector } from "../../connectors-greenhouse/src/greenhouse-connector.js";
import { HrmosConnector } from "../../connectors-hrmos/src/hrmos-connector.js";
import { SchemaOrgConnector } from "../../connectors-schema-org/src/schema-org-connector.js";
import type { SourceInstanceRef } from "../../contracts/src/index.js";
import type { OutboxDatabase } from "../../db/src/outbox.js";
import { ExtractionService } from "../../extraction/src/extraction-service.js";
import { SourceSyncService } from "../../ingestion/src/source-sync-service.js";
import { DeterministicJobParser } from "../../parser/src/deterministic-job-parser.js";
import { createObjectStore } from "../../../scripts/object-store-config.js";
import type { SourceSyncWorkflowInput } from "../../workflows/src/source-sync-workflow.js";

const { Pool } = pg;

interface SourceRow {
  id: string;
  source_kind: "greenhouse" | "schema_org" | "manual" | "hrmos";
  tenant_key: string;
  base_url: string;
}

export interface SourcePipelineResult {
  sourceInstanceId: string;
  snapshotKind: string;
  rawVersionsSelected: number;
  extractionsSucceeded: number;
  canonicalsMaterialized: number;
}

export interface FinalizeRefreshFailureInput {
  refreshRequestId: string;
  reason: string;
}

export async function finalizeRefreshFailureActivity(input: FinalizeRefreshFailureInput): Promise<void> {
  const execution = activityInfo().workflowExecution;
  if (execution === undefined) throw ApplicationFailure.nonRetryable("Workflow execution metadata is missing", "WORKFLOW_METADATA_MISSING");
  const pool = new Pool({ connectionString: required("DATABASE_URL") });
  const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool }) });
  try {
    await sql`UPDATE on_demand_refresh_requests SET status='failed',temporal_workflow_id=${execution.workflowId},
      started_at=COALESCE(started_at,now()),completed_at=now(),failure_code='pipeline_terminal_failure',
      failure_detail=${JSON.stringify({ message: input.reason.slice(0, 2_000) })}::jsonb
      WHERE id=${input.refreshRequestId}::uuid AND status<>'succeeded'`.execute(db);
  } finally {
    await db.destroy();
  }
}

export async function runSourcePipelineActivity(input: SourceSyncWorkflowInput): Promise<SourcePipelineResult> {
  const databaseUrl = required("DATABASE_URL");
  const info = activityInfo();
  const execution = info.workflowExecution;
  if (execution === undefined) throw ApplicationFailure.nonRetryable("Workflow execution metadata is missing", "WORKFLOW_METADATA_MISSING");
  const activityKey = `${execution.workflowId}:${execution.runId}:${info.activityId}`;
  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool }) });
  try {
    const cached = await claimExecution(db, activityKey, execution.workflowId,
      execution.runId, info.activityId);
    if (cached !== null) {
      if (input.refreshRequestId !== undefined) {
        await markRefreshSucceeded(db, input.refreshRequestId, execution.workflowId);
      }
      return cached;
    }
    try {
      const result = await runPipeline(db, input, execution.workflowId, execution.runId);
      await sql`UPDATE temporal_activity_executions SET status='succeeded',result=${JSON.stringify(result)}::jsonb,
        locked_at=NULL,lock_owner=NULL,updated_at=now() WHERE activity_key=${activityKey}`.execute(db);
      if (input.refreshRequestId !== undefined) {
        await markRefreshSucceeded(db, input.refreshRequestId, execution.workflowId);
      }
      return result;
    } catch (error) {
      await sql`UPDATE temporal_activity_executions SET status='failed',result=${JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      })}::jsonb,locked_at=NULL,lock_owner=NULL,updated_at=now() WHERE activity_key=${activityKey}`.execute(db);
      if (input.refreshRequestId !== undefined) {
        await sql`UPDATE on_demand_refresh_requests SET status='retrying',temporal_workflow_id=${execution.workflowId},
          started_at=COALESCE(started_at,now()),failure_code='pipeline_retry',failure_detail=${JSON.stringify({
            message: error instanceof Error ? error.message : String(error),
          })}::jsonb WHERE id=${input.refreshRequestId}::uuid AND status<>'succeeded'`.execute(db);
      }
      throw error;
    }
  } finally {
    await db.destroy();
  }
}

async function markRefreshSucceeded(db: Kysely<OutboxDatabase>, requestId: string, workflowId: string): Promise<void> {
  await sql`UPDATE on_demand_refresh_requests SET status='succeeded',temporal_workflow_id=${workflowId},
    started_at=COALESCE(started_at,now()),completed_at=now(),failure_code=NULL,failure_detail=NULL
    WHERE id=${requestId}::uuid`.execute(db);
}

async function runPipeline(db: Kysely<OutboxDatabase>, input: SourceSyncWorkflowInput,
  workflowId: string, runId: string): Promise<SourcePipelineResult> {
  const sourceResult = await sql<SourceRow>`SELECT id,source_kind,tenant_key,base_url FROM source_instances
    WHERE id=${input.sourceInstanceId}::uuid AND verification_state='verified'`.execute(db);
  const row = sourceResult.rows[0];
  if (row === undefined) throw ApplicationFailure.nonRetryable("Verified source does not exist", "SOURCE_NOT_VERIFIED");
  if (row.source_kind === "manual") throw ApplicationFailure.nonRetryable("Manual sources are not scheduled", "MANUAL_SOURCE");
  const source: SourceInstanceRef = { id: row.id, sourceKind: row.source_kind, tenantKey: row.tenant_key, baseUrl: row.base_url };
  const store = createObjectStore();
  const idempotencyKey = `temporal:${workflowId}:${runId}`;
  let snapshotKind = "reused";
  if (row.source_kind === "greenhouse" || row.source_kind === "hrmos") {
    const connector = row.source_kind === "greenhouse" ? new GreenhouseConnector() : new HrmosConnector();
    const result = await new SourceSyncService(db, connector, store).run({
      source, idempotencyKey, temporalWorkflowId: workflowId, temporalRunId: runId,
    });
    snapshotKind = result.snapshot?.kind ?? "reused";
  } else {
    const record = await sql<{ stable_key: string; canonical_url: string }>`SELECT stable_key,canonical_url FROM source_job_records
      WHERE source_instance_id=${row.id}::uuid ORDER BY first_seen_at LIMIT 1`.execute(db);
    const identity = record.rows[0];
    if (identity === undefined) throw ApplicationFailure.nonRetryable("Schema source has no seeded record identity", "SCHEMA_IDENTITY_MISSING");
    const result = await new SourceSyncService(db, new SchemaOrgConnector(), store).run({
      source, idempotencyKey, temporalWorkflowId: workflowId, temporalRunId: runId,
      recordIdentity: { sourceInstanceId: row.id, stableKey: identity.stable_key, canonicalUrl: identity.canonical_url },
    });
    snapshotKind = result.snapshot?.kind ?? "reused";
  }
  const parser = new DeterministicJobParser();
  const versions = await sql<{ id: string }>`SELECT v.id FROM source_job_versions v JOIN source_job_records r ON r.id=v.source_job_record_id
    WHERE r.source_instance_id=${row.id}::uuid AND NOT EXISTS(SELECT 1 FROM source_job_extractions e
      WHERE e.source_job_version_id=v.id AND e.parser_key=${parser.parserKey} AND e.parser_version=${parser.parserVersion}
      AND e.schema_version=${parser.schemaVersion}) ORDER BY v.fetched_at`.execute(db);
  const extractionService = new ExtractionService(db, store);
  const canonicalService = new CanonicalService(db);
  let succeeded = 0;
  let materialized = 0;
  for (const version of versions.rows) {
    const extraction = await extractionService.extract(version.id, parser);
    if (extraction.status !== "succeeded") continue;
    succeeded += 1;
    await canonicalService.materialize(extraction.extractionId);
    materialized += 1;
  }
  await sql`UPDATE source_schedules SET next_run_at=now()+make_interval(hours=>interval_hours),updated_at=now()
    WHERE source_instance_id=${row.id}::uuid`.execute(db);
  return { sourceInstanceId: row.id, snapshotKind, rawVersionsSelected: versions.rows.length,
    extractionsSucceeded: succeeded, canonicalsMaterialized: materialized };
}

async function claimExecution(db: Kysely<OutboxDatabase>, activityKey: string, workflowId: string,
  runId: string, activityId: string): Promise<SourcePipelineResult | null> {
  const owner = randomUUID();
  const inserted = await sql<{ activity_key: string }>`INSERT INTO temporal_activity_executions(activity_key,activity_type,
      temporal_workflow_id,temporal_run_id,temporal_activity_id,status,locked_at,lock_owner)
    VALUES (${activityKey},'source_pipeline',${workflowId},${runId},${activityId},'running',now(),${owner})
    ON CONFLICT(activity_key) DO NOTHING RETURNING activity_key`.execute(db);
  if (inserted.rows[0] !== undefined) return null;
  const existing = await sql<{ status: string; result: SourcePipelineResult | null; locked_at: Date | null }>`SELECT status,result,locked_at
    FROM temporal_activity_executions WHERE activity_key=${activityKey}`.execute(db);
  const row = existing.rows[0];
  if (row?.status === "succeeded" && row.result !== null) return row.result;
  if (row?.status === "running" && row.locked_at !== null && row.locked_at.getTime() > Date.now() - 10 * 60_000) {
    throw ApplicationFailure.retryable("Activity execution lease is held", "ACTIVITY_LEASE_HELD");
  }
  await sql`UPDATE temporal_activity_executions SET status='running',locked_at=now(),lock_owner=${owner},updated_at=now()
    WHERE activity_key=${activityKey}`.execute(db);
  return null;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}
