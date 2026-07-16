import { promises as fs } from "node:fs";
import path from "node:path";
import { auditRecruitmentEntrypoint, detectSource, type RecruitmentEntrypointAudit } from "../packages/discovery/src/recruitment-entry-auditor.js";

interface EntrypointRow {
  externalKey: string;
  displayName: string;
  officialSiteUrl: string | null;
  audit: RecruitmentEntrypointAudit;
}
interface EntrypointFile { auditedAt: string; results: EntrypointRow[] }
const input = JSON.parse(await fs.readFile(path.resolve("tmp/recruitment-entrypoint-audits.json"), "utf8")) as EntrypointFile;
const queue = input.results.flatMap((row) => selectCandidateLinks(row).map((url) => ({
  externalKey: row.externalKey, displayName: row.displayName, officialSiteUrl: row.officialSiteUrl, url,
})));
const results: Array<(typeof queue)[number] & { audit: RecruitmentEntrypointAudit }> = [];
let cursor = 0;
const concurrency = 8;
async function worker(): Promise<void> {
  while (cursor < queue.length) {
    const item = queue[cursor++];
    if (item === undefined) return;
    results.push({ ...item, audit: await auditRecruitmentEntrypoint(item.url) });
    if (results.length % 50 === 0 || results.length === queue.length) process.stdout.write(`audited ${results.length}/${queue.length}\n`);
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));
results.sort((a, b) => a.externalKey.localeCompare(b.externalKey) || a.url.localeCompare(b.url));
const outputPath = path.resolve("tmp/recruitment-candidate-audits.json");
await fs.writeFile(outputPath, `${JSON.stringify({ auditedAt: new Date().toISOString(), results }, null, 2)}\n`, { mode: 0o600 });
const sourceCounts = new Map<string, number>();
const companies = new Set<string>();
for (const result of results) for (const source of result.audit.detectedSources) {
  sourceCounts.set(source.kind, (sourceCounts.get(source.kind) ?? 0) + 1);
  companies.add(result.externalKey);
}
process.stdout.write(`${JSON.stringify({ outputPath, requests: queue.length,
  companiesWithDetectedSource: companies.size,
  detectedSources: Object.fromEntries([...sourceCounts].sort((a, b) => b[1] - a[1])) })}\n`);

function selectCandidateLinks(row: EntrypointRow): string[] {
  const unique = [...new Set(row.audit.candidateLinks)];
  return unique.map((url) => ({ url, score: score(url) })).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url)).slice(0, 6).map((item) => item.url);
}

function score(value: string): number {
  if (detectSource(value) !== null) return 1_000;
  const url = new URL(value);
  const text = `${url.hostname}${decodeURIComponent(url.pathname)}`.toLowerCase();
  let result = 0;
  if (/\/(jobs?|positions?|job-offers?)(\/|$)/.test(text)) result += 100;
  if (/career|recruit|採用|求人|募集/.test(text)) result += 40;
  if (/guideline|requirement|recruitment|detail|information/.test(text)) result += 25;
  if (/contact|entry|interview|message|about|welfare|faq|voice|member|data|environment|privacy|news|blog|twitter|facebook/.test(text)) result -= 60;
  if (/\.(pdf|jpg|jpeg|png)$/i.test(url.pathname)) result -= 100;
  return result;
}
