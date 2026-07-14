import { promises as fs } from "node:fs";
import path from "node:path";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
const auditKey = process.env.PROMOTION_AUDIT_KEY ?? "jetro-promotion:2026-07-14";
const { Client } = pg;
const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  const rows = await client.query<{ external_key: string; display_name: string; status: string; current_job_count: number;
    detected_sources: unknown; audited_at: Date; linked: boolean }>(`SELECT c.external_key,c.display_name,a.status,a.current_job_count,
      a.detected_sources,a.audited_at,c.linked_company_id IS NOT NULL linked FROM company_promotion_audits a
      JOIN company_discovery_candidates c ON c.id=a.company_discovery_candidate_id
      WHERE a.audit_key=$1 ORDER BY c.external_key`, [auditKey]);
  const sourceCounts = await client.query<{ source_kind: string; sources: number; jobs: number }>(`SELECT s.source_kind,
      count(DISTINCT s.id)::int sources,count(r.id)::int jobs FROM source_instances s
      JOIN source_discovery_candidates sdc ON sdc.linked_source_instance_id=s.id AND sdc.state='verified'
      JOIN company_discovery_candidates cdc ON cdc.id=sdc.company_discovery_candidate_id
      JOIN company_promotion_audits pa ON pa.company_discovery_candidate_id=cdc.id AND pa.audit_key=$1
      LEFT JOIN source_job_records r ON r.source_instance_id=s.id AND r.lifecycle_state='active' WHERE s.verification_state='verified'
      GROUP BY s.source_kind ORDER BY s.source_kind`, [auditKey]);
  const statusCounts = Object.fromEntries(Object.entries(Object.groupBy(rows.rows, (row) => row.status))
    .map(([status, values]) => [status, values?.length ?? 0]));
  const payload = { generatedAt: new Date().toISOString(), auditKey,
    totalCompanies: rows.rows.length, linkedCompanies: rows.rows.filter((row) => row.linked).length,
    statusCounts, sourceCounts: sourceCounts.rows,
    companies: rows.rows.map((row) => ({ externalKey: row.external_key, displayName: row.display_name,
      status: row.status, currentJobCount: row.current_job_count, detectedSources: row.detected_sources })) };
  const jsonPath = path.resolve("config/jetro-ofp-promotion-audit-2026-07-14.json");
  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  const active = rows.rows.filter((row) => row.status === "promoted_active");
  const markdown = `# JETRO OFP promotion audit — 2026-07-14

All ${rows.rows.length} JETRO OFP company candidates reached a terminal promotion status and ${rows.rows.filter((row) => row.linked).length} are linked to formal Company records. Discovery evidence never creates a job by itself.

## Terminal status counts

| Status | Companies |
|---|---:|
${Object.entries(statusCounts).sort().map(([status, count]) => `| ${status} | ${count} |`).join("\n")}

## Verified active sources

| Source kind | Sources | Active jobs |
|---|---:|---:|
${sourceCounts.rows.map((row) => `| ${row.source_kind} | ${row.sources} | ${row.jobs} |`).join("\n")}

## Promoted companies

| Company | Active jobs |
|---|---:|
${active.map((row) => `| ${row.display_name.replaceAll("|", "\\|")} | ${row.current_job_count} |`).join("\n")}

The remaining companies stay in the formal Company and promotion-audit registry as unreachable, insecure, unsupported, unstructured, or currently without a machine-verifiable job source. They are not recommendation-eligible until a later audit proves an active official source.
`;
  const markdownPath = path.resolve("docs/delivery/jetro-ofp-promotion-2026-07-14.md");
  await fs.writeFile(markdownPath, markdown);
  process.stdout.write(`${JSON.stringify({ jsonPath, markdownPath, companies: rows.rows.length, active: active.length })}\n`);
} finally {
  await client.end();
}
