import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SchemaOrgConnector, findJobPosting } from "../packages/connectors-schema-org/src/schema-org-connector.js";

interface Seed {
  companyName: string;
  officialDomain: string;
  officialCareerUrl: string;
  jobUrl: string;
  tenantKey: string;
}

const seeds = JSON.parse(await fs.readFile(path.resolve("config/verified-schema-org-sources.json"), "utf8")) as Seed[];
const connector = new SchemaOrgConnector();
const results = [];
for (const seed of seeds) {
  const failures: string[] = [];
  const official = await fetch(seed.officialCareerUrl, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
  const officialHtml = await official.text();
  const officialLinkVerified = official.ok
    && new URL(official.url).hostname === seed.officialDomain
    && officialHtml.includes(new URL(seed.jobUrl).pathname.split("/").at(-1) ?? seed.jobUrl);
  if (!officialLinkVerified) failures.push("official career page does not link the configured HRMOS job");
  let title: string | null = null;
  let externalId: string | null = null;
  try {
    const record = await connector.fetchRecord({
      sourceInstanceId: randomUUID(), stableKey: seed.tenantKey, canonicalUrl: seed.jobUrl,
    }, AbortSignal.timeout(20_000));
    const posting = findJobPosting(record.raw);
    title = typeof posting.title === "string" ? posting.title : null;
    externalId = record.identity.externalId ?? null;
    if (title === null || title.length === 0) failures.push("JobPosting has no title");
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  results.push({
    ...seed, auditedAt: new Date().toISOString(), officialLinkVerified,
    jobPostingVerified: title !== null, title, externalId,
    status: failures.length === 0 ? "verified" : "failed", failures,
  });
}
await fs.mkdir(path.resolve("tmp"), { recursive: true });
await fs.writeFile(path.resolve("tmp/live-schema-org-audit.json"), `${JSON.stringify(results, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
if (results.some((result) => result.status === "failed")) process.exitCode = 1;

