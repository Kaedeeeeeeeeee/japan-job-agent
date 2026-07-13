import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
const { Client } = pg;
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const report: Record<string, unknown> = {};
try {
  const seeds = await one<{ total: number; verified: number }>(`SELECT count(*)::int total,
    count(*) FILTER(WHERE audit_state='verified')::int verified FROM company_seed_audits`);
  requireCheck(seeds.total === 16 && seeds.verified >= 10, "seed audit acceptance failed");
  report.seeds = seeds;

  const greenhouse = await client.query<{ tenant_key: string; active_jobs: number }>(`SELECT s.tenant_key,
    count(*) FILTER(WHERE r.lifecycle_state='active')::int active_jobs FROM source_instances s
    JOIN source_job_records r ON r.source_instance_id=s.id WHERE s.source_kind='greenhouse'
      AND s.verification_state='verified' GROUP BY s.id,s.tenant_key HAVING count(*) FILTER(WHERE r.lifecycle_state='active')>0`);
  requireCheck(greenhouse.rows.length >= 3, "fewer than three live Greenhouse sources");
  report.greenhouse = greenhouse.rows;

  const schema = await one<{ sources: number; jobs: number }>(`SELECT count(DISTINCT s.id)::int sources,count(r.id)::int jobs
    FROM source_instances s JOIN source_job_records r ON r.source_instance_id=s.id
    WHERE s.source_kind='schema_org' AND s.verification_state='verified' AND r.lifecycle_state='active'`);
  requireCheck(schema.sources >= 2 && schema.jobs >= 2, "schema.org single-record acceptance failed");
  report.schemaOrg = schema;

  const uniqueness = await one<{ records: number; unique_records: number; raw_versions: number; unique_raw_versions: number }>(`SELECT
    (SELECT count(*)::int FROM source_job_records) records,
    (SELECT count(DISTINCT (source_instance_id,stable_key))::int FROM source_job_records) unique_records,
    (SELECT count(*)::int FROM source_job_versions) raw_versions,
    (SELECT count(DISTINCT (source_job_record_id,raw_hash))::int FROM source_job_versions) unique_raw_versions`);
  requireCheck(uniqueness.records === uniqueness.unique_records && uniqueness.raw_versions === uniqueness.unique_raw_versions,
    "source or raw version duplicates detected");
  report.uniqueness = uniqueness;

  const evidence: Record<string, { nonUnknown: number; missingEvidence: number; unknown: number }> = {};
  for (const field of ["employmentTypes", "visaSupport", "locations", "languages", "compensation"] as const) {
    const row = await one<{ non_unknown: number; missing_evidence: number; unknown: number }>(`SELECT
      count(*) FILTER(WHERE v.structured_result->$1->>'state' IN ('known','conflicting'))::int non_unknown,
      count(*) FILTER(WHERE v.structured_result->$1->>'state' IN ('known','conflicting') AND NOT EXISTS(
        SELECT 1 FROM canonical_field_evidence cfe WHERE cfe.canonical_job_version_id=v.id AND cfe.field_path=$1))::int missing_evidence,
      count(*) FILTER(WHERE COALESCE(v.structured_result->$1->>'state','unknown')='unknown')::int unknown
      FROM canonical_jobs c JOIN canonical_job_versions v ON v.id=c.current_version_id`, [field]);
    requireCheck(row.missing_evidence === 0, `${field} evidence coverage is below 100%`);
    evidence[field] = { nonUnknown: row.non_unknown, missingEvidence: row.missing_evidence, unknown: row.unknown };
  }
  report.evidence = evidence;

  const erroneousClosures = await one<{ count: number }>(`SELECT count(*)::int count FROM job_state_transitions t
    JOIN source_sync_runs r ON r.id=t.source_sync_run_id WHERE t.to_state='closed' AND (r.status<>'succeeded' OR r.snapshot_kind<>'authoritative')`);
  requireCheck(erroneousClosures.count === 0, "failed or non-authoritative sync closed a job");
  report.erroneousClosures = erroneousClosures.count;

  const canonical = await one<{ jobs: number; active: number; primary_inputs_invalid: number; primary_sources_invalid: number }>(`SELECT
    (SELECT count(*)::int FROM canonical_jobs) jobs,
    (SELECT count(*)::int FROM canonical_jobs WHERE lifecycle_state='active') active,
    (SELECT count(*)::int FROM (SELECT canonical_job_version_id FROM canonical_materialization_inputs
      GROUP BY canonical_job_version_id HAVING count(*) FILTER(WHERE input_role='primary')<>1) x) primary_inputs_invalid,
    (SELECT count(*)::int FROM (SELECT canonical_job_id FROM canonical_job_sources WHERE active_to IS NULL
      GROUP BY canonical_job_id HAVING count(*) FILTER(WHERE source_role='primary')<>1) x) primary_sources_invalid`);
  requireCheck(canonical.primary_inputs_invalid === 0 && canonical.primary_sources_invalid === 0, "canonical primary invariant failed");
  report.canonical = canonical;

  const operations = await one<{ schedules: number; successful_activities: number; restore_ready_migrations: number }>(`SELECT
    (SELECT count(*)::int FROM source_schedules ss JOIN source_instances s ON s.id=ss.source_instance_id
      WHERE s.verification_state='verified' AND s.source_kind<>'manual') schedules,
    (SELECT count(*)::int FROM temporal_activity_executions WHERE status='succeeded') successful_activities,
    (SELECT count(*)::int FROM schema_migrations) restore_ready_migrations`);
  requireCheck(operations.schedules >= 5 && operations.successful_activities >= 1 && operations.restore_ready_migrations >= 7,
    "operations acceptance failed");
  report.operations = operations;
  process.stdout.write(`${JSON.stringify({ accepted: true, ...report }, null, 2)}\n`);
} finally { await client.end(); }

async function one<T>(query: string, values: unknown[] = []): Promise<T> {
  const result = await client.query<T & pg.QueryResultRow>(query, values);
  const row = result.rows[0];
  if (row === undefined) throw new Error("Acceptance query returned no rows");
  return row;
}

function requireCheck(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
