import { promises as fs } from "node:fs";
import path from "node:path";
import { auditRecruitmentEntrypoint, type RecruitmentEntrypointAudit } from "../packages/discovery/src/recruitment-entry-auditor.js";
import type { JetroOfpCompanyDetail } from "../packages/discovery/src/jetro-ofp.js";

interface DetailAuditFile { auditedAt: string; providerTotal: number; details: JetroOfpCompanyDetail[]; failures: unknown[] }
const input = JSON.parse(await fs.readFile(path.resolve("tmp/jetro-ofp-company-details.json"), "utf8")) as DetailAuditFile;
const results: Array<{ externalKey: string; displayName: string; officialSiteUrl: string | null; audit: RecruitmentEntrypointAudit }> = [];
let cursor = 0;
const concurrency = 6;
async function worker(): Promise<void> {
  while (cursor < input.details.length) {
    const index = cursor++;
    const detail = input.details[index];
    if (detail === undefined || detail.recruitmentUrl === null) continue;
    const audit = await auditRecruitmentEntrypoint(detail.recruitmentUrl);
    results.push({ externalKey: detail.externalKey, displayName: detail.displayName, officialSiteUrl: detail.officialSiteUrl, audit });
    if (results.length % 25 === 0 || results.length === input.details.length) process.stdout.write(`audited ${results.length}/${input.details.length}\n`);
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));
results.sort((a, b) => a.externalKey.localeCompare(b.externalKey));
const outputPath = path.resolve("tmp/recruitment-entrypoint-audits.json");
await fs.writeFile(outputPath, `${JSON.stringify({ auditedAt: new Date().toISOString(), results }, null, 2)}\n`, { mode: 0o600 });
const statusCounts = Object.groupBy(results, (result) => result.audit.status);
const sourceCounts = new Map<string, number>();
for (const result of results) for (const source of result.audit.detectedSources) {
  sourceCounts.set(source.kind, (sourceCounts.get(source.kind) ?? 0) + 1);
}
process.stdout.write(`${JSON.stringify({ outputPath, total: results.length,
  statuses: Object.fromEntries(Object.entries(statusCounts).map(([key, rows]) => [key, rows?.length ?? 0])),
  detectedSources: Object.fromEntries([...sourceCounts].sort((a, b) => b[1] - a[1])),
  secure: results.filter((result) => result.audit.transportSecure).length })}\n`);
