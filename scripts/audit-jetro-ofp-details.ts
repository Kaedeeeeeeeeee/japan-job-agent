import { promises as fs } from "node:fs";
import path from "node:path";
import type { DiscoveryPage } from "../packages/contracts/src/index.js";
import { parseJetroOfpDetail, parseJetroOfpPage, type JetroOfpCompanyDetail } from "../packages/discovery/src/jetro-ofp.js";

const fetchedAt = new Date().toISOString();
const listPages: DiscoveryPage[] = [];
let pageNumber: number | null = 1;
while (pageNumber !== null) {
  const url = new URL("https://www.jetro.go.jp/hrportal/company.html");
  url.searchParams.set("page", String(pageNumber));
  url.searchParams.set("region", "all");
  const response = await fetchPublic(url);
  const parsed = parseJetroOfpPage(await response.text(), url.toString(), pageNumber, fetchedAt);
  if (parsed.candidates.length === 0) throw new Error(`JETRO OFP list page ${pageNumber} returned no companies`);
  listPages.push(parsed);
  pageNumber = parsed.nextPage;
}

const candidates = listPages.flatMap((page) => page.candidates);
const expected = listPages[0]?.providerTotal;
if (expected !== undefined && candidates.length !== expected) throw new Error(`JETRO list total mismatch: ${candidates.length}/${expected}`);

const details: JetroOfpCompanyDetail[] = [];
const failures: Array<{ externalKey: string; detailUrl: string; error: string }> = [];
const concurrency = 4;
let cursor = 0;
async function worker(): Promise<void> {
  while (cursor < candidates.length) {
    const index = cursor++;
    const candidate = candidates[index];
    if (candidate === undefined) return;
    try {
      const response = await fetchPublic(new URL(candidate.detailUrl));
      details.push(parseJetroOfpDetail(await response.text(), candidate.detailUrl, fetchedAt));
    } catch (error) {
      failures.push({ externalKey: candidate.externalKey, detailUrl: candidate.detailUrl,
        error: error instanceof Error ? error.message : String(error) });
    }
    const completed = details.length + failures.length;
    if (completed % 25 === 0 || completed === candidates.length) process.stdout.write(`audited ${completed}/${candidates.length}\n`);
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));
details.sort((a, b) => a.externalKey.localeCompare(b.externalKey));
failures.sort((a, b) => a.externalKey.localeCompare(b.externalKey));

const output = { auditedAt: fetchedAt, providerTotal: expected ?? candidates.length, details, failures };
await fs.mkdir(path.resolve("tmp"), { recursive: true });
const outputPath = path.resolve("tmp/jetro-ofp-company-details.json");
await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
const hostCounts = new Map<string, number>();
for (const detail of details) {
  if (detail.recruitmentUrl === null) continue;
  const host = new URL(detail.recruitmentUrl).hostname;
  hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
}
process.stdout.write(`${JSON.stringify({ outputPath, details: details.length, failures: failures.length,
  withOfficialSite: details.filter((item) => item.officialSiteUrl !== null).length,
  withRecruitmentUrl: details.filter((item) => item.recruitmentUrl !== null).length,
  recruitmentHosts: [...hostCounts].sort((a, b) => b[1] - a[1]).slice(0, 30) })}\n`);

async function fetchPublic(url: URL): Promise<Response> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000), headers: {
    accept: "text/html,application/xhtml+xml", "user-agent": "JapanJobAgent/0.2 (+private personal use)",
  } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response;
}
