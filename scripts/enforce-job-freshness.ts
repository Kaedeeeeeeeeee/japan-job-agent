import { randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import {
  JOB_RETENTION_MONTHS,
  UNKNOWN_PUBLICATION_GRACE_DAYS,
  subtractCalendarMonths,
  tokyoCalendarDate,
} from "../packages/freshness/src/job-freshness.js";
import { createObjectStore } from "./object-store-config.js";

const POLICY_VERSION = "published-six-calendar-months-v1";
const databaseUrl = required("DATABASE_URL");
const apply = process.argv.includes("--apply");
const batchSize = integerArgument("--batch-size", 500, 1, 5_000);
const rawDeleteBatchSize = integerArgument("--raw-delete-batch-size", 200, 1, 1_000);
const now = dateArgument("--now") ?? new Date();
const today = tokyoCalendarDate(now);
const cutoffDate = subtractCalendarMonths(today, JOB_RETENTION_MONTHS);
const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl, max: 4 });

interface ImpactReport {
  cutoffDate: string;
  today: string;
  discovery: {
    recent: number;
    old: number;
    future: number;
    unknownQuarantine: number;
    unknownDue: number;
    alreadyPurged: number;
  };
  canonical: {
    recent: number;
    old: number;
    future: number;
    unknownQuarantine: number;
    unknownDue: number;
    rawObjectsToQueue: number;
  };
}

interface RunCounts {
  discoveryPurged: number;
  canonicalJobsPurged: number;
  sourceRecordsPurged: number;
  rawObjectsQueued: number;
  rawObjectsDeleted: number;
  rawObjectDeleteFailures: number;
}

let runId: string | null = null;
try {
  const before = await impactReport();
  if (!apply) {
    process.stdout.write(`${JSON.stringify({ mode: "dry-run", policyVersion: POLICY_VERSION, impact: before }, null, 2)}\n`);
  } else {
    runId = randomUUID();
    await pool.query(`INSERT INTO job_retention_runs(
        id,policy_version,cutoff_date,unknown_grace_days,batch_size,status
      ) VALUES ($1,$2,$3,$4,$5,'running')`, [
      runId, POLICY_VERSION, cutoffDate, UNKNOWN_PUBLICATION_GRACE_DAYS, batchSize,
    ]);
    const counts: RunCounts = {
      discoveryPurged: 0,
      canonicalJobsPurged: 0,
      sourceRecordsPurged: 0,
      rawObjectsQueued: 0,
      rawObjectsDeleted: 0,
      rawObjectDeleteFailures: 0,
    };
    for (;;) {
      const purged = await purgeDiscoveryBatch();
      counts.discoveryPurged += purged;
      if (purged < batchSize) break;
    }
    for (;;) {
      const purged = await purgeCanonicalBatch();
      counts.canonicalJobsPurged += purged.canonicalJobs;
      counts.sourceRecordsPurged += purged.sourceRecords;
      counts.rawObjectsQueued += purged.rawObjectsQueued;
      if (purged.canonicalJobs < batchSize) break;
    }
    for (;;) {
      const deleted = await deleteRawObjectBatch();
      counts.rawObjectsDeleted += deleted.deleted;
      counts.rawObjectDeleteFailures += deleted.failed;
      if (deleted.claimed < rawDeleteBatchSize) break;
    }
    await recordDailyMetrics();
    const after = await impactReport();
    await pool.query(`UPDATE job_retention_runs SET status='succeeded',completed_at=now(),counts=$2::jsonb
      WHERE id=$1`, [runId, JSON.stringify(counts)]);
    process.stdout.write(`${JSON.stringify({ mode: "apply", policyVersion: POLICY_VERSION, runId, before, counts, after }, null, 2)}\n`);
  }
} catch (error) {
  if (runId !== null) {
    await pool.query(`UPDATE job_retention_runs SET status='failed',completed_at=now(),error_detail=$2
      WHERE id=$1 AND status='running'`, [runId, error instanceof Error ? error.message.slice(0, 4_000) : String(error).slice(0, 4_000)]);
  }
  throw error;
} finally {
  await pool.end();
}

async function impactReport(): Promise<ImpactReport> {
  const discovery = await pool.query<{
    recent: number;
    old: number;
    future: number;
    unknown_quarantine: number;
    unknown_due: number;
    already_purged: number;
  }>(`WITH candidates AS (
      SELECT *,COALESCE(source_published_date,(source_published_at AT TIME ZONE 'Asia/Tokyo')::date) publication_date
      FROM job_discovery_candidates
    ) SELECT
      count(*) FILTER(WHERE content_purged_at IS NULL AND publication_date BETWEEN $1::date AND $2::date)::int recent,
      count(*) FILTER(WHERE content_purged_at IS NULL AND publication_date<$1::date)::int old,
      count(*) FILTER(WHERE content_purged_at IS NULL AND publication_date>$2::date)::int future,
      count(*) FILTER(WHERE content_purged_at IS NULL AND publication_date IS NULL
        AND publication_check_due_at>$3::timestamptz)::int unknown_quarantine,
      count(*) FILTER(WHERE content_purged_at IS NULL AND publication_date IS NULL
        AND publication_check_due_at<=$3::timestamptz)::int unknown_due,
      count(*) FILTER(WHERE content_purged_at IS NOT NULL)::int already_purged
    FROM candidates`, [cutoffDate, today, now.toISOString()]);
  const canonical = await pool.query<{
    recent: number;
    old: number;
    future: number;
    unknown_quarantine: number;
    unknown_due: number;
    raw_objects_to_queue: number;
  }>(`${canonicalFreshnessCte()}
    SELECT
      count(DISTINCT fresh_jobs.canonical_job_id) FILTER(WHERE published_state='known' AND publication_date BETWEEN $1::date AND $2::date)::int recent,
      count(DISTINCT fresh_jobs.canonical_job_id) FILTER(WHERE published_state='known' AND publication_date<$1::date)::int old,
      count(DISTINCT fresh_jobs.canonical_job_id) FILTER(WHERE published_state='known' AND publication_date>$2::date)::int future,
      count(DISTINCT fresh_jobs.canonical_job_id) FILTER(WHERE COALESCE(published_state,'unknown')<>'known'
        AND first_seen_at>$3::timestamptz-interval '7 days')::int unknown_quarantine,
      count(DISTINCT fresh_jobs.canonical_job_id) FILTER(WHERE COALESCE(published_state,'unknown')<>'known'
        AND first_seen_at<=$3::timestamptz-interval '7 days')::int unknown_due,
      count(DISTINCT raw.raw_storage_key) FILTER(WHERE
        (published_state='known' AND (publication_date<$1::date OR publication_date>$2::date))
        OR (COALESCE(published_state,'unknown')<>'known' AND first_seen_at<=$3::timestamptz-interval '7 days'))::int raw_objects_to_queue
    FROM fresh_jobs
    LEFT JOIN canonical_job_sources link ON link.canonical_job_id=fresh_jobs.canonical_job_id AND link.active_to IS NULL
    LEFT JOIN source_job_versions raw ON raw.source_job_record_id=link.source_job_record_id`,
  [cutoffDate, today, now.toISOString()]);
  const d = discovery.rows[0];
  const c = canonical.rows[0];
  if (d === undefined || c === undefined) throw new Error("Freshness impact query returned no row");
  return {
    cutoffDate,
    today,
    discovery: {
      recent: d.recent,
      old: d.old,
      future: d.future,
      unknownQuarantine: d.unknown_quarantine,
      unknownDue: d.unknown_due,
      alreadyPurged: d.already_purged,
    },
    canonical: {
      recent: c.recent,
      old: c.old,
      future: c.future,
      unknownQuarantine: c.unknown_quarantine,
      unknownDue: c.unknown_due,
      rawObjectsToQueue: c.raw_objects_to_queue,
    },
  };
}

async function purgeDiscoveryBatch(): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='30s'");
    const selected = await client.query<{ id: string }>(`SELECT id FROM job_discovery_candidates
      WHERE content_purged_at IS NULL AND (
        COALESCE(source_published_date,(source_published_at AT TIME ZONE 'Asia/Tokyo')::date)<$1::date
        OR COALESCE(source_published_date,(source_published_at AT TIME ZONE 'Asia/Tokyo')::date)>$2::date
        OR (source_published_precision IS NULL AND publication_check_due_at<=$3::timestamptz)
      ) ORDER BY COALESCE(retention_expires_on,'0001-01-01'::date),id
      LIMIT $4 FOR UPDATE SKIP LOCKED`, [cutoffDate, today, now.toISOString(), batchSize]);
    const ids = selected.rows.map((row) => row.id);
    if (ids.length === 0) {
      await client.query("COMMIT");
      return 0;
    }
    await insertCandidateTombstones(client, ids);
    await deleteCandidateContent(client, ids, "publication_retention_elapsed");
    await client.query("COMMIT");
    return ids.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function purgeCanonicalBatch(): Promise<{ canonicalJobs: number; sourceRecords: number; rawObjectsQueued: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='60s'");
    const selected = await client.query<{ canonical_job_id: string }>(`${canonicalFreshnessCte()}
      SELECT fresh_jobs.canonical_job_id FROM fresh_jobs
      JOIN canonical_jobs locked_job ON locked_job.id=fresh_jobs.canonical_job_id WHERE
        (published_state='known' AND (publication_date<$1::date OR publication_date>$2::date))
        OR (COALESCE(published_state,'unknown')<>'known' AND first_seen_at<=$3::timestamptz-interval '7 days')
      ORDER BY first_seen_at,fresh_jobs.canonical_job_id LIMIT $4 FOR UPDATE OF locked_job SKIP LOCKED`,
    [cutoffDate, today, now.toISOString(), batchSize]);
    const canonicalIds = selected.rows.map((row) => row.canonical_job_id);
    if (canonicalIds.length === 0) {
      await client.query("COMMIT");
      return { canonicalJobs: 0, sourceRecords: 0, rawObjectsQueued: 0 };
    }
    const records = await client.query<{ id: string }>(`SELECT DISTINCT link.source_job_record_id id
      FROM canonical_job_sources link WHERE link.canonical_job_id=ANY($1::uuid[])`, [canonicalIds]);
    const recordIds = records.rows.map((row) => row.id);
    const versions = await client.query<{ id: string; raw_storage_key: string }>(`SELECT id,raw_storage_key
      FROM source_job_versions WHERE source_job_record_id=ANY($1::uuid[])`, [recordIds]);
    const versionIds = versions.rows.map((row) => row.id);
    const canonicalVersions = await client.query<{ id: string }>(`SELECT id FROM canonical_job_versions
      WHERE canonical_job_id=ANY($1::uuid[])`, [canonicalIds]);
    const canonicalVersionIds = canonicalVersions.rows.map((row) => row.id);
    const candidateRows = await client.query<{ id: string }>(`SELECT id FROM job_discovery_candidates
      WHERE promoted_source_job_record_id=ANY($1::uuid[]) FOR UPDATE`, [recordIds]);
    const candidateIds = candidateRows.rows.map((row) => row.id);
    if (candidateIds.length > 0) {
      await insertCandidateTombstones(client, candidateIds);
      await deleteCandidateContent(client, candidateIds, "canonical_publication_retention_elapsed");
    }
    await client.query(`INSERT INTO job_retention_tombstones(
        identity_fingerprint,normalized_detail_url_hash,source_family,tenant_key,external_posting_id,
        reason,last_seen_at
      ) SELECT DISTINCT ON (fingerprint)
        fingerprint,detail_hash,source_kind::text,tenant_key,external_id,'canonical_publication_retention_elapsed',last_seen_at
      FROM (
        SELECT encode(digest(CASE WHEN record.external_id IS NOT NULL
            THEN 'external:'||source.source_kind::text||':'||source.tenant_key||':'||record.external_id
            ELSE 'detail:'||COALESCE(record.normalized_application_url,record.canonical_url) END,'sha256'),'hex') fingerprint,
          encode(digest(COALESCE(record.normalized_application_url,record.canonical_url),'sha256'),'hex') detail_hash,
          source.source_kind,source.tenant_key,record.external_id,record.last_seen_at
        FROM source_job_records record JOIN source_instances source ON source.id=record.source_instance_id
        WHERE record.id=ANY($1::uuid[])
      ) retained ORDER BY fingerprint,last_seen_at DESC
      ON CONFLICT DO NOTHING`, [recordIds]);
    const queued = await client.query(`INSERT INTO raw_object_purge_queue(object_key)
      SELECT DISTINCT target.raw_storage_key FROM source_job_versions target
      WHERE target.source_job_record_id=ANY($1::uuid[]) AND NOT EXISTS(
        SELECT 1 FROM source_job_versions retained WHERE retained.raw_storage_key=target.raw_storage_key
          AND NOT (retained.source_job_record_id=ANY($1::uuid[]))
      )
      ON CONFLICT(object_key) DO NOTHING`, [recordIds]);
    await client.query(`DELETE FROM recommendation_runs run WHERE EXISTS(
      SELECT 1 FROM recommendation_results result WHERE result.recommendation_run_id=run.id
        AND result.canonical_job_id=ANY($1::uuid[]))`, [canonicalIds]);
    if (versionIds.length > 0 || canonicalVersionIds.length > 0) {
      await client.query(`DELETE FROM ai_tasks WHERE payload->>'sourceJobVersionId'=ANY($1::text[])
        OR payload->>'canonicalJobVersionId'=ANY($2::text[])`, [versionIds, canonicalVersionIds]);
    }
    if (canonicalVersionIds.length > 0) {
      await client.query(`DELETE FROM outbox_events WHERE aggregate_id=ANY($1::uuid[])`, [canonicalVersionIds]);
    }
    await client.query(`UPDATE job_promotion_attempts SET source_job_record_id=NULL,canonical_job_id=NULL,updated_at=now()
      WHERE source_job_record_id=ANY($1::uuid[]) OR canonical_job_id=ANY($2::uuid[])`, [recordIds, canonicalIds]);
    await client.query(`DELETE FROM canonical_jobs WHERE id=ANY($1::uuid[])`, [canonicalIds]);
    await client.query(`DELETE FROM source_job_records WHERE id=ANY($1::uuid[])`, [recordIds]);
    await client.query("COMMIT");
    return { canonicalJobs: canonicalIds.length, sourceRecords: recordIds.length, rawObjectsQueued: queued.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertCandidateTombstones(client: PoolClient, ids: string[]): Promise<void> {
  await client.query(`INSERT INTO job_retention_tombstones(
      identity_fingerprint,normalized_detail_url_hash,source_family,tenant_key,external_posting_id,
      source_published_date,source_published_at,source_published_precision,reason,last_seen_at
    ) SELECT DISTINCT ON (identity_fingerprint)
      identity_fingerprint,normalized_detail_url_hash,source_family,tenant_key,external_posting_id,
      source_published_date,source_published_at,source_published_precision,
      CASE WHEN source_published_precision IS NULL THEN 'publication_date_unknown_after_grace'
        WHEN COALESCE(source_published_date,(source_published_at AT TIME ZONE 'Asia/Tokyo')::date)>$2::date
          THEN 'published_in_future' ELSE 'published_older_than_retention_window' END,last_seen_at
    FROM job_discovery_candidates WHERE id=ANY($1::uuid[])
    ORDER BY identity_fingerprint,last_seen_at DESC ON CONFLICT DO NOTHING`, [ids, today]);
}

async function deleteCandidateContent(client: PoolClient, ids: string[], reason: string): Promise<void> {
  await client.query(`DELETE FROM job_discovery_observations WHERE candidate_id=ANY($1::uuid[])`, [ids]);
  await client.query(`DELETE FROM job_discovery_resolution_evidence WHERE candidate_id=ANY($1::uuid[])`, [ids]);
  await client.query(`DELETE FROM job_discovery_review_cluster_members WHERE candidate_id=ANY($1::uuid[])`, [ids]);
  await client.query(`DELETE FROM job_promotion_attempts WHERE candidate_id=ANY($1::uuid[])`, [ids]);
  await client.query(`UPDATE job_discovery_candidates SET
      state='expired',publication_freshness='expired',publication_check_due_at=NULL,
      detail_url='https://expired.invalid/jobs/'||id::text,
      normalized_detail_url='https://expired.invalid/jobs/'||id::text,
      official_url=NULL,normalized_official_url=NULL,
      company_name='[expired]',normalized_company_name='expired',title='[expired]',
      location_text='',location_state='unknown',observation_count=0,
      last_authoritative_seen_at=NULL,last_authoritative_import_run_id=NULL,
      resolved_source_instance_id=NULL,promoted_source_job_record_id=NULL,
      rejection_reason=$2,content_purged_at=COALESCE(content_purged_at,now()),updated_at=now()
    WHERE id=ANY($1::uuid[])`, [ids, reason]);
}

async function deleteRawObjectBatch(): Promise<{ claimed: number; deleted: number; failed: number }> {
  const workerId = `job-freshness:${randomUUID()}`;
  const client = await pool.connect();
  let claimed: Array<{ id: string; object_key: string }> = [];
  try {
    await client.query("BEGIN");
    const result = await client.query<{ id: string; object_key: string }>(`WITH candidates AS (
        SELECT id FROM raw_object_purge_queue WHERE available_at<=$1::timestamptz AND (
          state IN ('pending','failed') OR (state='leased' AND leased_at<$1::timestamptz-interval '15 minutes')
        ) ORDER BY available_at,created_at,id LIMIT $2 FOR UPDATE SKIP LOCKED
      ) UPDATE raw_object_purge_queue queue SET state='leased',lease_owner=$3,leased_at=now(),
        attempt_count=attempt_count+1,updated_at=now() FROM candidates WHERE queue.id=candidates.id
      RETURNING queue.id,queue.object_key`, [now.toISOString(), rawDeleteBatchSize, workerId]);
    claimed = result.rows;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const store = createObjectStore();
  let deleted = 0;
  let failed = 0;
  for (const item of claimed) {
    try {
      await store.delete(item.object_key);
      await pool.query(`UPDATE raw_object_purge_queue SET state='deleted',lease_owner=NULL,leased_at=NULL,
        deleted_at=now(),last_error=NULL,updated_at=now() WHERE id=$1 AND lease_owner=$2`, [item.id, workerId]);
      deleted += 1;
    } catch (error) {
      await pool.query(`UPDATE raw_object_purge_queue SET state='failed',lease_owner=NULL,leased_at=NULL,
        available_at=now()+interval '1 hour',last_error=$3,updated_at=now() WHERE id=$1 AND lease_owner=$2`, [
        item.id, workerId, error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
      ]);
      failed += 1;
    }
  }
  return { claimed: claimed.length, deleted, failed };
}

async function recordDailyMetrics(): Promise<void> {
  await pool.query(`${canonicalFreshnessCte()}, metrics AS (
      SELECT
        (SELECT count(*)::int FROM job_discovery_candidates
          WHERE (first_seen_at AT TIME ZONE 'Asia/Tokyo')::date=$1::date) discovered_today,
        (SELECT count(*)::int FROM job_discovery_candidates
          WHERE publication_freshness='recent' AND state NOT IN ('rejected','expired')) recent_candidates,
        (SELECT count(*)::int FROM job_discovery_candidates
          WHERE publication_freshness='unknown_quarantine' AND state NOT IN ('rejected','expired')) unknown_candidates,
        (SELECT count(*)::int FROM job_discovery_candidates WHERE state='expired') expired_candidates,
        count(*) FILTER(WHERE published_state='known' AND publication_date BETWEEN $2::date AND $1::date)::int canonical_recent,
        count(*) FILTER(WHERE COALESCE(published_state,'unknown')<>'known')::int canonical_unknown,
        count(*) FILTER(WHERE published_state='known' AND (publication_date<$2::date OR publication_date>$1::date))::int canonical_expired,
        (SELECT count(*)::int FROM job_discovery_candidates WHERE content_purged_at IS NOT NULL) purged_candidates,
        (SELECT count(*)::int FROM job_retention_tombstones) tombstones,
        (SELECT count(*)::int FROM raw_object_purge_queue WHERE state<>'deleted') raw_pending
      FROM fresh_jobs
    ) INSERT INTO job_freshness_daily_metrics(
      measured_on,retention_cutoff,discovered_today,recent_candidates,unknown_quarantine_candidates,
      expired_candidates,active_canonical_recent,active_canonical_unknown,active_canonical_expired,
      purged_candidates_total,tombstones_total,raw_objects_pending
    ) SELECT $1::date,$2::date,discovered_today,recent_candidates,unknown_candidates,expired_candidates,
      canonical_recent,canonical_unknown,canonical_expired,purged_candidates,tombstones,raw_pending FROM metrics
    ON CONFLICT(measured_on) DO UPDATE SET measured_at=now(),retention_cutoff=excluded.retention_cutoff,
      discovered_today=excluded.discovered_today,recent_candidates=excluded.recent_candidates,
      unknown_quarantine_candidates=excluded.unknown_quarantine_candidates,expired_candidates=excluded.expired_candidates,
      active_canonical_recent=excluded.active_canonical_recent,active_canonical_unknown=excluded.active_canonical_unknown,
      active_canonical_expired=excluded.active_canonical_expired,purged_candidates_total=excluded.purged_candidates_total,
      tombstones_total=excluded.tombstones_total,raw_objects_pending=excluded.raw_objects_pending`, [today, cutoffDate]);
}

function canonicalFreshnessCte(): string {
  return `WITH fresh_jobs AS (
    SELECT canonical_job.id canonical_job_id,
      published_state.value_state::text published_state,
      published_date.publication_date,primary_source.first_seen_at
    FROM canonical_jobs canonical_job
    JOIN canonical_job_versions version ON version.id=canonical_job.current_version_id
    JOIN LATERAL (
      SELECT record.first_seen_at FROM canonical_job_sources link
      JOIN source_job_records record ON record.id=link.source_job_record_id
      WHERE link.canonical_job_id=canonical_job.id AND link.source_role='primary' AND link.active_to IS NULL
      ORDER BY link.active_from LIMIT 1
    ) primary_source ON true
    LEFT JOIN canonical_job_date_states published_state
      ON published_state.canonical_job_version_id=version.id AND published_state.date_kind='published'
    LEFT JOIN LATERAL (
      SELECT COALESCE(date.date_value,(date.timestamp_value AT TIME ZONE 'Asia/Tokyo')::date) publication_date
      FROM canonical_job_dates date WHERE date.canonical_job_version_id=version.id AND date.date_kind='published'
      ORDER BY (date.source_role='primary') DESC,date.id LIMIT 1
    ) published_date ON true
    WHERE canonical_job.lifecycle_state='active'
  )`;
}

function integerArgument(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = stringArgument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function dateArgument(name: string): Date | undefined {
  const raw = stringArgument(name);
  if (raw === undefined) return undefined;
  const value = new Date(raw);
  if (!Number.isFinite(value.getTime())) throw new Error(`${name} must be an ISO date or timestamp`);
  return value;
}

function stringArgument(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}
