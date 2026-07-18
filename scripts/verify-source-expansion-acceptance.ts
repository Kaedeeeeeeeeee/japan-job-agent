import { Client, Connection } from "@temporalio/client";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { OutboxDatabase } from "../packages/db/src/outbox.js";
import { DeterministicJobParser } from "../packages/parser/src/deterministic-job-parser.js";
import { SourceExpansionStore } from "../packages/source-expansion/src/source-expansion-store.js";

const { Pool } = pg;
const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: required("DATABASE_URL") }) }) });
const store = new SourceExpansionStore(db);
const parser = new DeterministicJobParser();
const failures: string[] = [];
let runId: string | undefined;

try {
  runId = await store.beginRun("acceptance");
  const metrics = await store.metrics();
  check(metrics.engageValidShare < 0.5, `Engage valid share ${formatShare(metrics.engageValidShare)} is not below 50%`);
  check(metrics.nonEngageValid >= 19_216, `non-Engage valid jobs ${metrics.nonEngageValid} is below 19,216`);
  check(metrics.activeTrustedJobs >= 5_000, `active trusted jobs ${metrics.activeTrustedJobs} is below 5,000`);

  const quality = (await sql<{ older_than_six_months: number; future_published: number; duplicate_application_urls: number;
    missing_current_version: number; unverified_visible: number; current_parser_missing: number }>`WITH visible_candidates AS (
      SELECT * FROM job_discovery_candidates WHERE location_state='japan' AND state NOT IN ('rejected','expired')
        AND publication_freshness='recent' AND content_purged_at IS NULL
    ), visible_formal AS (
      SELECT job.id,job.current_version_id,record.id record_id,record.normalized_application_url,
        source.id source_id,source.verification_state source_verification
      FROM canonical_jobs job LEFT JOIN canonical_job_sources link ON link.canonical_job_id=job.id AND link.active_to IS NULL
      LEFT JOIN source_job_records record ON record.id=link.source_job_record_id AND record.lifecycle_state='active'
      LEFT JOIN source_instances source ON source.id=record.source_instance_id
      WHERE job.lifecycle_state='active'
    ) SELECT
      ((SELECT count(*)::int FROM visible_candidates WHERE COALESCE(source_published_date,
        (source_published_at AT TIME ZONE 'Asia/Tokyo')::date)<
          ((now() AT TIME ZONE 'Asia/Tokyo')::date-interval '6 months')::date)
        +(SELECT count(DISTINCT job.id)::int FROM canonical_jobs job
          JOIN canonical_job_dates published ON published.canonical_job_version_id=job.current_version_id
            AND published.date_kind='published'
          WHERE job.lifecycle_state='active' AND COALESCE(published.date_value,
            (published.timestamp_value AT TIME ZONE 'Asia/Tokyo')::date)<
              ((now() AT TIME ZONE 'Asia/Tokyo')::date-interval '6 months')::date)) older_than_six_months,
      ((SELECT count(*)::int FROM visible_candidates WHERE COALESCE(source_published_date,
        (source_published_at AT TIME ZONE 'Asia/Tokyo')::date)>(now() AT TIME ZONE 'Asia/Tokyo')::date)
        +(SELECT count(DISTINCT job.id)::int FROM canonical_jobs job
          JOIN canonical_job_dates published ON published.canonical_job_version_id=job.current_version_id
            AND published.date_kind='published'
          WHERE job.lifecycle_state='active' AND COALESCE(published.date_value,
            (published.timestamp_value AT TIME ZONE 'Asia/Tokyo')::date)>(now() AT TIME ZONE 'Asia/Tokyo')::date)) future_published,
      (SELECT count(*)::int FROM (SELECT normalized_application_url FROM visible_formal
        WHERE normalized_application_url IS NOT NULL GROUP BY normalized_application_url
        HAVING count(DISTINCT id)>1) duplicate) duplicate_application_urls,
      (SELECT count(DISTINCT id)::int FROM visible_formal WHERE current_version_id IS NULL) missing_current_version,
      (SELECT count(*)::int FROM canonical_jobs job WHERE job.lifecycle_state='active' AND NOT EXISTS(
        SELECT 1 FROM canonical_job_sources link
        JOIN source_job_records record ON record.id=link.source_job_record_id AND record.lifecycle_state='active'
        JOIN source_instances source ON source.id=record.source_instance_id AND source.verification_state='verified'
        JOIN company_source_relationships relationship ON relationship.source_instance_id=source.id
          AND relationship.verification_state='verified' AND relationship.valid_to IS NULL
        JOIN evidence ON evidence.company_source_relationship_id=relationship.id
        WHERE link.canonical_job_id=job.id AND link.active_to IS NULL)) unverified_visible,
      (SELECT count(DISTINCT formal.record_id)::int FROM visible_formal formal
        WHERE formal.record_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM source_job_versions raw
          JOIN source_job_extractions extraction ON extraction.source_job_version_id=raw.id
            AND extraction.parser_key=${parser.parserKey} AND extraction.parser_version=${parser.parserVersion}
            AND extraction.schema_version=${parser.schemaVersion} AND extraction.status='succeeded'
          WHERE raw.source_job_record_id=formal.record_id)) current_parser_missing`.execute(db)).rows[0]!;
  check(quality.older_than_six_months === 0, `${quality.older_than_six_months} visible jobs are older than six months`);
  check(quality.future_published === 0, `${quality.future_published} visible jobs have a future publication date`);
  check(quality.duplicate_application_urls === 0, `${quality.duplicate_application_urls} duplicate application URL groups remain`);
  check(quality.missing_current_version === 0, `${quality.missing_current_version} visible Canonical jobs have no current version`);
  check(quality.unverified_visible === 0, `${quality.unverified_visible} unverified Canonical jobs remain visible`);
  check(quality.current_parser_missing === 0, `${quality.current_parser_missing} visible records lack the current parser`);

  const databaseHealth = (await sql<{ blocked_sources: number; missing_schedules: number; stale_running_syncs: number;
    active_leases_expired: number; verified_source_schedules: number }>`SELECT
      (SELECT count(*)::int FROM source_instances WHERE verification_state='verified' AND health_state='blocked') blocked_sources,
      (SELECT count(*)::int FROM source_instances source WHERE source.verification_state='verified'
        AND source.source_kind<>'manual' AND NOT EXISTS(SELECT 1 FROM source_schedules schedule
          WHERE schedule.source_instance_id=source.id)) missing_schedules,
      (SELECT count(*)::int FROM source_sync_runs WHERE status='running' AND started_at<now()-interval '4 hours') stale_running_syncs,
      (SELECT count(*)::int FROM source_tenant_candidates WHERE lease_expires_at<now()) active_leases_expired,
      (SELECT count(*)::int FROM source_instances WHERE verification_state='verified' AND source_kind<>'manual')
        verified_source_schedules`.execute(db)).rows[0]!;
  check(databaseHealth.blocked_sources === 0, `${databaseHealth.blocked_sources} verified sources are blocked`);
  check(databaseHealth.missing_schedules === 0, `${databaseHealth.missing_schedules} verified sources lack schedules`);
  check(databaseHealth.stale_running_syncs === 0, `${databaseHealth.stale_running_syncs} source syncs have run over four hours`);
  check(databaseHealth.active_leases_expired === 0, `${databaseHealth.active_leases_expired} tenant scan leases are expired`);

  const runtimeHealth = await checkRuntimeHealth(databaseHealth.verified_source_schedules);
  const previousDailyCycle = await previousCyclePassed();
  const corePassed = failures.length === 0;
  await store.finishRun(runId, corePassed ? "succeeded" : "failed", { corePassed, metrics, quality, databaseHealth, runtimeHealth });
  const consecutiveDailyCycles = corePassed ? (previousDailyCycle ? 2 : 1) : 0;
  if (corePassed && !previousDailyCycle) failures.push("targets and health must pass again on the next Tokyo calendar day");
  const accepted = failures.length === 0 && consecutiveDailyCycles >= 2;
  process.stdout.write(`${JSON.stringify({ accepted, consecutiveDailyCycles, failures, metrics, quality,
    health: { database: databaseHealth, runtime: runtimeHealth }, runId }, null, 2)}\n`);
  if (!accepted) process.exitCode = 1;
} catch (error) {
  if (runId !== undefined) await store.finishRun(runId, "failed", {}, [error instanceof Error ? error.message : String(error)]);
  throw error;
} finally {
  await db.destroy();
}

async function checkRuntimeHealth(expectedSourceSchedules: number): Promise<Record<string, unknown>> {
  const requiredHealth = process.env.SOURCE_EXPANSION_REQUIRE_RUNTIME_HEALTH === "true";
  const apiUrl = process.env.AGENT_API_BASE_URL;
  const temporalAddress = process.env.TEMPORAL_ADDRESS;
  if (requiredHealth) {
    check(apiUrl !== undefined, "AGENT_API_BASE_URL is required for final runtime acceptance");
    check(temporalAddress !== undefined, "TEMPORAL_ADDRESS is required for final runtime acceptance");
  }
  let api: Record<string, unknown> | null = null;
  if (apiUrl !== undefined) {
    const started = performance.now();
    try {
      const response = await fetch(new URL("/health/ready", apiUrl), { signal: AbortSignal.timeout(20_000), headers:
        process.env.API_INTERNAL_TOKEN === undefined ? {} : { authorization: `Bearer ${process.env.API_INTERNAL_TOKEN}` } });
      api = { ok: response.ok, status: response.status, durationMs: Math.round(performance.now() - started) };
      check(response.ok, `API readiness returned HTTP ${response.status}`);
    } catch (error) {
      api = { ok: false, error: error instanceof Error ? error.message : String(error) };
      check(false, "API readiness check failed");
    }
  }
  let temporal: Record<string, unknown> | null = null;
  if (temporalAddress !== undefined) {
    let connection: Connection | undefined;
    try {
      connection = await Connection.connect({ address: temporalAddress });
      const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
      const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "japan-job-agent";
      const client = new Client({ connection, namespace });
      const [workflowQueue, activityQueue] = await Promise.all([
        connection.workflowService.describeTaskQueue({ namespace, taskQueue: { name: taskQueue }, taskQueueType: 1 }),
        connection.workflowService.describeTaskQueue({ namespace, taskQueue: { name: taskQueue }, taskQueueType: 2 }),
      ]);
      const workflowPollers = workflowQueue.pollers.length;
      const activityPollers = activityQueue.pollers.length;
      let sourceSchedules = 0;
      for await (const schedule of client.schedule.list()) {
        if (schedule.scheduleId.startsWith("source-")) sourceSchedules += 1;
      }
      temporal = { ok: workflowPollers > 0 && activityPollers > 0 && sourceSchedules >= expectedSourceSchedules,
        address: temporalAddress, workflowPollers, activityPollers, sourceSchedules, expectedSourceSchedules };
      check(workflowPollers > 0 && activityPollers > 0, "Temporal worker has no workflow or activity poller");
      check(sourceSchedules >= expectedSourceSchedules,
        `Temporal has ${sourceSchedules}/${expectedSourceSchedules} verified source schedules`);
    } catch (error) {
      temporal = { ok: false, error: error instanceof Error ? error.message : String(error) };
      check(false, "Temporal connection health check failed");
    } finally {
      await connection?.close();
    }
  }
  return { required: requiredHealth, api, temporal };
}

async function previousCyclePassed(): Promise<boolean> {
  const result = await sql<{ passed: boolean }>`SELECT EXISTS(SELECT 1 FROM source_expansion_runs
    WHERE run_kind='acceptance' AND status='succeeded' AND id<>${runId!}::uuid
      AND (started_at AT TIME ZONE 'Asia/Tokyo')::date=(now() AT TIME ZONE 'Asia/Tokyo')::date-1
      AND COALESCE((final_metrics->>'engageValidShare')::numeric,1)<0.5
      AND COALESCE((final_metrics->>'nonEngageValid')::int,0)>=19216
      AND COALESCE((final_metrics->>'activeTrustedJobs')::int,0)>=5000) passed`.execute(db);
  return result.rows[0]?.passed === true;
}

function check(condition: boolean, message: string): void { if (!condition) failures.push(message); }
function formatShare(value: number): string { return `${(value * 100).toFixed(2)}%`; }
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}
