import { promises as fs } from "node:fs";
import path from "node:path";

interface Seed {
  companyName: string;
  officialDomain: string;
  officialCareerUrl: string;
  tenantKey: string;
  boardUrl: string;
  domesticBoard?: boolean;
}

interface FeedJob {
  id: number;
  title: string;
  absolute_url: string;
  location: { name: string };
  content?: string;
}

interface AuditResult extends Seed {
  auditedAt: string;
  officialLinkVerified: boolean;
  activeJobCount: number;
  japanJobCount: number;
  sampleJapanJob: { id: number; title: string; url: string } | null;
  status: "verified" | "failed";
  failures: string[];
}

const configPath = path.resolve("config/verified-greenhouse-sources.json");
const seeds = JSON.parse(await fs.readFile(configPath, "utf8")) as Seed[];
const results = await Promise.all(seeds.map(audit));
await fs.mkdir(path.resolve("tmp"), { recursive: true });
await fs.writeFile(path.resolve("tmp/live-greenhouse-audit.json"), `${JSON.stringify(results, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
if (results.some((result) => result.status === "failed")) process.exitCode = 1;

async function audit(seed: Seed): Promise<AuditResult> {
  const failures: string[] = [];
  const career = await fetch(seed.officialCareerUrl, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
  if (!career.ok) failures.push(`official career page returned ${career.status}`);
  const finalHost = new URL(career.url).hostname;
  const careerHtml = await career.text();
  const normalizedBoardUrl = seed.boardUrl.replace(/\/$/, "");
  const officialLinkVerified = career.url.startsWith(normalizedBoardUrl)
    || careerHtml.includes(seed.boardUrl) || careerHtml.includes(normalizedBoardUrl);
  if (finalHost !== seed.officialDomain && !career.url.startsWith(normalizedBoardUrl)) {
    failures.push(`official page redirected to unexpected host ${finalHost}`);
  }
  if (!officialLinkVerified) failures.push(`official page does not link ${seed.boardUrl}`);

  const feedUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(seed.tenantKey)}/jobs?content=true`;
  const feed = await fetch(feedUrl, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
  if (!feed.ok) failures.push(`Greenhouse feed returned ${feed.status}`);
  const payload = await feed.json() as { jobs?: FeedJob[] };
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  if (jobs.length === 0) failures.push("Greenhouse feed contains no active jobs");
  const japanJobs = seed.domesticBoard === true ? jobs : jobs.filter(isJapanJob);
  if (japanJobs.length === 0) failures.push("Greenhouse feed contains no job with current Japan evidence");
  const sample = japanJobs[0];
  return {
    ...seed,
    auditedAt: new Date().toISOString(),
    officialLinkVerified,
    activeJobCount: jobs.length,
    japanJobCount: japanJobs.length,
    sampleJapanJob: sample === undefined ? null : { id: sample.id, title: sample.title, url: sample.absolute_url },
    status: failures.length === 0 ? "verified" : "failed",
    failures,
  };
}

function isJapanJob(job: FeedJob): boolean {
  const evidence = `${job.title}\n${job.location.name}`;
  return /Japan|Tokyo|Fukuoka|日本|東京|福岡/i.test(evidence);
}
