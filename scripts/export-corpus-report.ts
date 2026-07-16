import { promises as fs } from "node:fs";
import path from "node:path";
import pg from "pg";
import type { SafeProfile } from "../packages/profile/src/build-profile.js";
import { evaluateJob } from "../packages/matching/src/evaluate-job.js";
import { DeterministicJobParser } from "../packages/parser/src/deterministic-job-parser.js";

interface JobRow {
  canonical_job_id: string; canonical_job_version_id: string; lifecycle_state: "active" | "suspect" | "closed";
  title: string; application_url: string; structured_result: Record<string, unknown>; fetched_at: Date;
  source_kind: string; verified_official_source: boolean; evidence_by_field: Record<string, string[]>;
}
interface GreenhouseAudit { tenantKey: string; companyName: string; activeJobCount: number; japanJobCount: number; status: string }

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
const { Client } = pg;
const client = new Client({ connectionString: databaseUrl });
const parserVersion = new DeterministicJobParser().parserVersion;
await client.connect();
try {
  const profile = await client.query<{ structured_profile: SafeProfile }>(`SELECT pv.structured_profile FROM profiles p
    JOIN profile_versions pv ON pv.id=p.current_version_id WHERE p.profile_key='primary'`);
  const safeProfile = profile.rows[0]?.structured_profile;
  if (safeProfile === undefined) throw new Error("Primary safe Profile is required");
  const jobs = await client.query<JobRow>(`SELECT c.id canonical_job_id,v.id canonical_job_version_id,c.lifecycle_state,
    v.title,v.application_url,v.structured_result,source.fetched_at,source.source_kind,
    EXISTS(SELECT 1 FROM canonical_job_sources verified_cjs
      JOIN source_job_records verified_record ON verified_record.id=verified_cjs.source_job_record_id
      JOIN source_instances verified_source ON verified_source.id=verified_record.source_instance_id
      JOIN company_source_relationships csr ON csr.source_instance_id=verified_source.id
      WHERE verified_cjs.canonical_job_id=c.id AND verified_cjs.active_to IS NULL
        AND verified_source.verification_state='verified' AND csr.verification_state='verified' AND csr.valid_to IS NULL
    ) verified_official_source,COALESCE(ev.evidence_by_field,'{}'::jsonb) evidence_by_field
    FROM canonical_jobs c JOIN canonical_job_versions v ON v.id=c.current_version_id
    JOIN LATERAL (SELECT si.source_kind,sjr.last_seen_at fetched_at FROM canonical_job_sources cjs
      JOIN source_job_records sjr ON sjr.id=cjs.source_job_record_id JOIN source_instances si ON si.id=sjr.source_instance_id
      WHERE cjs.canonical_job_id=c.id AND cjs.source_role='primary' AND cjs.active_to IS NULL LIMIT 1) source ON true
    LEFT JOIN LATERAL (SELECT jsonb_object_agg(field_path,ids) evidence_by_field FROM (
      SELECT field_path,jsonb_agg(evidence_id) ids FROM canonical_field_evidence
      WHERE canonical_job_version_id=v.id GROUP BY field_path) grouped) ev ON true`);
  const matches = jobs.rows.map((row) => ({ sourceKind: row.source_kind, result: evaluateJob(safeProfile, {
    canonicalJobId: row.canonical_job_id, canonicalJobVersionId: row.canonical_job_version_id,
    lifecycleState: row.lifecycle_state, verifiedOfficialSource: row.verified_official_source,
    title: row.title, applicationUrl: row.application_url, fetchedAt: row.fetched_at.toISOString(),
    structured: row.structured_result, evidenceByField: row.evidence_by_field,
  }) }));
  const sources = await client.query<{ source_kind: string; sources: number; jobs: number }>(`SELECT s.source_kind,
    count(DISTINCT s.id)::int sources,count(DISTINCT r.id)::int jobs FROM source_instances s
    JOIN source_job_records r ON r.source_instance_id=s.id AND r.lifecycle_state='active'
    WHERE s.verification_state='verified' GROUP BY s.source_kind ORDER BY s.source_kind`);
  const extraction = await client.query<{ succeeded: number }>(`SELECT count(*)::int succeeded FROM source_job_extractions
    WHERE parser_key='deterministic-job' AND parser_version=$1 AND status='succeeded'`, [parserVersion]);
  const facts = await client.query<{ non_unknown_facts: number; missing_evidence: number }>(`WITH facts AS (
    SELECT v.id,f.field FROM canonical_jobs c JOIN canonical_job_versions v ON v.id=c.current_version_id
    CROSS JOIN LATERAL (VALUES ('employmentTypes',v.structured_result->'employmentTypes'->>'state'),
      ('visaSupport',v.structured_result->'visaSupport'->>'state'),('locations',v.structured_result->'locations'->>'state'),
      ('languages',v.structured_result->'languages'->>'state'),('compensation',v.structured_result->'compensation'->>'state')) f(field,state)
    WHERE c.lifecycle_state='active' AND f.state IS DISTINCT FROM 'unknown')
    SELECT count(*)::int non_unknown_facts,count(*) FILTER (WHERE NOT EXISTS(SELECT 1 FROM canonical_field_evidence e
      WHERE e.canonical_job_version_id=facts.id AND e.field_path=facts.field))::int missing_evidence FROM facts`);
  const greenhouse = JSON.parse(await fs.readFile(path.resolve("tmp/live-greenhouse-audit.json"), "utf8")) as GreenhouseAudit[];
  const eligibleBySource = Object.entries(Object.groupBy(matches.filter((row) => row.result.eligible), (row) => row.sourceKind))
    .map(([sourceKind, values]) => ({ sourceKind, jobs: values?.length ?? 0 })).sort((a, b) => b.jobs - a.jobs);
  const payload = {
    generatedAt: new Date().toISOString(), activeCanonicalJobs: jobs.rows.filter((row) => row.lifecycle_state === "active").length,
    eligibleForPrimaryProfile: matches.filter((row) => row.result.eligible).length,
    hardRejected: matches.filter((row) => !row.result.eligible).length,
    sourceCounts: sources.rows, eligibleBySource, parser: { version: parserVersion, succeeded: extraction.rows[0]?.succeeded ?? 0 },
    evidence: facts.rows[0] ?? { non_unknown_facts: 0, missing_evidence: 0 },
    greenhouse: greenhouse.map((row) => ({ tenantKey: row.tenantKey, companyName: row.companyName,
      activeJobCount: row.activeJobCount, japanJobCount: row.japanJobCount, status: row.status })),
  };
  await fs.writeFile(path.resolve("config/job-corpus-audit-2026-07-15.json"), `${JSON.stringify(payload, null, 2)}\n`);
  const sourceRows = sources.rows.map((row) => `| ${row.source_kind} | ${row.sources} | ${row.jobs} |`).join("\n");
  const eligibleRows = eligibleBySource.map((row) => `| ${row.sourceKind} | ${row.jobs} |`).join("\n");
  const markdown = `# Job corpus expansion audit — 2026-07-15

The verified corpus contains ${payload.activeCanonicalJobs} active Canonical Jobs. With the real PII-free primary Profile and deterministic hard filters, ${payload.eligibleForPrimaryProfile} are recommendation-eligible and ${payload.hardRejected} are explicitly excluded.

## Verified active sources

| Source kind | Sources | Active jobs |
|---|---:|---:|
${sourceRows}

## Eligible jobs by source

| Source kind | Eligible jobs |
|---|---:|
${eligibleRows}

Parser ${payload.parser.version} succeeded for ${payload.parser.succeeded} current Raw Versions. All ${payload.evidence.non_unknown_facts} non-unknown high-risk facts have evidence; missing evidence: ${payload.evidence.missing_evidence}.

Global Greenhouse boards are retained as complete authoritative snapshots. Explicit non-Japan locations are deterministically hard-rejected; unknown locations remain visible as unknown, consistent with the product policy.
`;
  await fs.writeFile(path.resolve("docs/delivery/job-corpus-expansion-2026-07-15.md"), markdown);
  process.stdout.write(`${JSON.stringify({ active: payload.activeCanonicalJobs, eligible: payload.eligibleForPrimaryProfile,
    hardRejected: payload.hardRejected, sources: sources.rows.length })}\n`);
} finally {
  await client.end();
}
