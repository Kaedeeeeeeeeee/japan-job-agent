import { performance } from "node:perf_hooks";
import pg from "pg";
import { DeterministicJobParser } from "../packages/parser/src/deterministic-job-parser.js";

const databaseUrl = required("DATABASE_URL");
const { Client } = pg;
const client = new Client({ connectionString: databaseUrl });
const activeParser = new DeterministicJobParser();
await client.connect();
const report: Record<string, unknown> = {};
const failures: string[] = [];
try {
  const discovery = await one<{ total: number; valid: number; unexplained: number }>(`SELECT
    count(*)::int total,
    count(*) FILTER(WHERE location_state='japan' AND state NOT IN ('rejected','expired') AND (
      (origin_kind='official_collection' AND last_authoritative_import_run_id IS NOT NULL
        AND last_authoritative_seen_at>=now()-interval '72 hours')
      OR (origin_kind<>'official_collection' AND observation_count>=2 AND last_seen_at>=now()-interval '30 days')))::int valid,
    count(*) FILTER(WHERE observation_count=0 OR (state IN ('rejected','expired') AND rejection_reason IS NULL)
      OR (state='promoted' AND promoted_source_job_record_id IS NULL))::int unexplained
    FROM job_discovery_candidates`);
  check(discovery.valid >= 10_000, `valid Discovery candidates ${discovery.valid} is below 10000`);
  check(discovery.unexplained === 0, "some candidates lack observation or terminal-state explanation");
  report.discovery = discovery;

  const families = await client.query<{ source_family: string; valid: number; share: number }>(`WITH counts AS (
      SELECT source_family,count(*)::int valid FROM job_discovery_candidates
      WHERE location_state='japan' AND state NOT IN ('rejected','expired') AND (
        (origin_kind='official_collection' AND last_authoritative_import_run_id IS NOT NULL
          AND last_authoritative_seen_at>=now()-interval '72 hours')
        OR (origin_kind<>'official_collection' AND observation_count>=2 AND last_seen_at>=now()-interval '30 days'))
      GROUP BY source_family), total AS (SELECT sum(valid)::numeric total FROM counts)
    SELECT source_family,valid,round(valid/NULLIF(total,0),6)::float8 share FROM counts,total ORDER BY valid DESC`);
  const maximumShare = Math.max(...families.rows.map((row) => row.share));
  check(maximumShare <= 0.4, `single discovery source family share ${maximumShare} exceeds 0.4`);
  report.sourceFamilies = families.rows;

  const formal = await one<{ active_verified: number; active_unverified: number; missing_application_url: number;
    duplicate_strong_keys: number }>(`SELECT
    count(DISTINCT cj.id) FILTER(WHERE verified)::int active_verified,
    count(DISTINCT cj.id) FILTER(WHERE NOT verified)::int active_unverified,
    count(DISTINCT cj.id) FILTER(WHERE verified AND (cv.application_url IS NULL OR cv.application_url=''))::int missing_application_url,
    (SELECT count(*)::int FROM (SELECT r.normalized_application_url FROM source_job_records r
      JOIN canonical_job_sources cjs ON cjs.source_job_record_id=r.id AND cjs.active_to IS NULL
      JOIN canonical_jobs duplicate_job ON duplicate_job.id=cjs.canonical_job_id AND duplicate_job.lifecycle_state='active'
      WHERE r.normalized_application_url IS NOT NULL GROUP BY r.normalized_application_url
      HAVING count(DISTINCT cjs.canonical_job_id)>1) duplicate_urls) duplicate_strong_keys
    FROM canonical_jobs cj JOIN canonical_job_versions cv ON cv.id=cj.current_version_id
    JOIN LATERAL (SELECT EXISTS(SELECT 1 FROM canonical_job_sources cjs
      JOIN source_job_records r ON r.id=cjs.source_job_record_id AND r.lifecycle_state='active'
      JOIN source_instances s ON s.id=r.source_instance_id AND s.verification_state='verified'
      JOIN company_source_relationships csr ON csr.source_instance_id=s.id
        AND csr.verification_state='verified' AND csr.valid_to IS NULL
      JOIN evidence e ON e.company_source_relationship_id=csr.id
      WHERE cjs.canonical_job_id=cj.id AND cjs.active_to IS NULL) verified) trust ON true
    WHERE cj.lifecycle_state='active'`);
  check(formal.active_verified >= 2_000, `verified active Canonical Jobs ${formal.active_verified} is below 2000`);
  check(formal.active_unverified === 0 && formal.missing_application_url === 0,
    "an active Canonical Job lacks verified official source or application URL");
  check(formal.duplicate_strong_keys === 0, "active Canonical Jobs contain duplicate normalized application URLs");
  report.formal = formal;

  const evidence = await one<{ non_unknown: number; missing: number; date_non_unknown: number; date_missing: number }>(`WITH facts AS (
      SELECT v.id version_id,f.field FROM canonical_jobs c JOIN canonical_job_versions v ON v.id=c.current_version_id
      CROSS JOIN LATERAL (VALUES ('employmentTypes',v.structured_result->'employmentTypes'->>'state'),
        ('visaSupport',v.structured_result->'visaSupport'->>'state'),('locations',v.structured_result->'locations'->>'state'),
        ('languages',v.structured_result->'languages'->>'state'),('compensation',v.structured_result->'compensation'->>'state')) f(field,state)
      WHERE c.lifecycle_state='active' AND f.state IN ('known','conflicting')),
    dates AS (SELECT ds.canonical_job_version_id,ds.date_kind FROM canonical_job_date_states ds
      JOIN canonical_jobs c ON c.current_version_id=ds.canonical_job_version_id AND c.lifecycle_state='active'
      WHERE ds.value_state IN ('known','conflicting'))
    SELECT count(facts.*)::int non_unknown,
      count(facts.*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM canonical_field_evidence cfe
        WHERE cfe.canonical_job_version_id=facts.version_id AND cfe.field_path=facts.field))::int missing,
      (SELECT count(*)::int FROM dates) date_non_unknown,
      (SELECT count(*)::int FROM dates WHERE NOT EXISTS(SELECT 1 FROM canonical_job_dates d
        WHERE d.canonical_job_version_id=dates.canonical_job_version_id AND d.date_kind=dates.date_kind
          AND d.evidence_id IS NOT NULL)) date_missing FROM facts`);
  check(evidence.missing === 0 && evidence.date_missing === 0, "non-unknown formal facts are missing Evidence");
  report.evidence = evidence;

  const safety = await one<{ erroneous_closures: number; formal_records_without_raw: number;
    current_parser_succeeded: number; active_formal_records_missing_current_parser: number }>(`SELECT
    (SELECT count(*)::int FROM job_state_transitions t JOIN source_sync_runs run ON run.id=t.source_sync_run_id
      WHERE t.to_state='closed' AND (run.status<>'succeeded' OR run.snapshot_kind<>'authoritative')) erroneous_closures,
    (SELECT count(*)::int FROM source_job_records r JOIN source_instances s ON s.id=r.source_instance_id
      WHERE r.lifecycle_state='active' AND s.verification_state='verified'
        AND NOT EXISTS(SELECT 1 FROM source_job_versions v WHERE v.source_job_record_id=r.id)) formal_records_without_raw,
    (SELECT count(*)::int FROM source_job_extractions WHERE parser_key='deterministic-job'
      AND parser_version=$1 AND schema_version=$2 AND status='succeeded') current_parser_succeeded,
    (SELECT count(DISTINCT record.id)::int FROM source_job_records record
      JOIN source_instances source ON source.id=record.source_instance_id AND source.verification_state='verified'
      JOIN company_source_relationships relationship ON relationship.source_instance_id=source.id
        AND relationship.verification_state='verified' AND relationship.valid_to IS NULL
      JOIN canonical_job_sources link ON link.source_job_record_id=record.id AND link.active_to IS NULL
      JOIN canonical_jobs job ON job.id=link.canonical_job_id AND job.lifecycle_state='active'
      WHERE record.lifecycle_state='active' AND NOT EXISTS(SELECT 1 FROM source_job_versions raw
        JOIN source_job_extractions extraction ON extraction.source_job_version_id=raw.id
          AND extraction.parser_key='deterministic-job' AND extraction.parser_version=$1
          AND extraction.schema_version=$2 AND extraction.status='succeeded'
        WHERE raw.source_job_record_id=record.id)) active_formal_records_missing_current_parser`,
  [activeParser.parserVersion, activeParser.schemaVersion]);
  check(safety.erroneous_closures === 0 && safety.formal_records_without_raw === 0,
    "formal lifecycle safety or Raw-version invariant failed");
  check(safety.active_formal_records_missing_current_parser === 0,
    "an active formal Source Job Record lacks a successful current Parser extraction");
  report.safety = { parserVersion: activeParser.parserVersion, schemaVersion: activeParser.schemaVersion, ...safety };

  const benchmark = process.env.AGENT_API_BASE_URL === undefined ? null : await benchmarkAgentApi(
    process.env.AGENT_API_BASE_URL, process.env.API_INTERNAL_TOKEN);
  if (benchmark !== null) check(benchmark.p95Ms <= 500, `Agent API p95 ${benchmark.p95Ms}ms exceeds 500ms`);
  report.agentApi = benchmark;
  process.stdout.write(`${JSON.stringify({ accepted: failures.length === 0, failures, ...report }, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await client.end();
}

async function benchmarkAgentApi(baseUrl: string, token: string | undefined): Promise<{ samples: number; p50Ms: number; p95Ms: number }> {
  const url = new URL("/agent/jobs", baseUrl);
  const headers = token === undefined ? {} : { authorization: `Bearer ${token}` };
  for (let index = 0; index < 3; index += 1) await checkedFetch(url, headers);
  const durations: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    await checkedFetch(url, headers);
    durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  return { samples: durations.length, p50Ms: round(durations[Math.floor(durations.length * 0.5)] ?? 0),
    p95Ms: round(durations[Math.ceil(durations.length * 0.95) - 1] ?? 0) };
}

async function checkedFetch(url: URL, headers: Record<string, string>): Promise<void> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Agent API benchmark received HTTP ${response.status}`);
  await response.arrayBuffer();
}

async function one<T>(query: string, values: unknown[] = []): Promise<T> {
  const result = await client.query<T & pg.QueryResultRow>(query, values);
  const row = result.rows[0];
  if (row === undefined) throw new Error("Acceptance query returned no row");
  return row;
}

function check(condition: boolean, message: string): void { if (!condition) failures.push(message); }
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
function round(value: number): number { return Math.round(value * 10) / 10; }
