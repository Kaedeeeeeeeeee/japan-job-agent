import { promises as fs } from "node:fs";
import path from "node:path";
import {
  candidatesFromText,
  deduplicateArtifactCandidates,
  githubTenantQueries,
  matchCompanyNameSignal,
  tenantCandidateArtifactSchema,
  type TenantCandidateArtifactItem,
} from "../packages/source-expansion/src/tenant-artifact.js";
import { replaceWithAtomicFile } from "../packages/operations/src/atomic-file.js";

interface SearchRepository {
  url?: string;
  html_url?: string;
  full_name?: string;
  name?: string;
  description?: string | null;
  homepage?: string | null;
  repositoryCname?: string;
}

interface SearchItem {
  name?: string;
  path?: string;
  html_url?: string;
  repository?: SearchRepository;
  text_matches?: Array<{ fragment?: string }>;
}

const token = required("GITHUB_TOKEN");
const outputPath = path.resolve(valueAfter("--output") ?? "tmp/source-tenant-candidates.json");
const summaryPath = path.resolve(valueAfter("--summary") ?? "tmp/source-tenant-candidates.md");
const requestBudget = positiveInteger(process.env.GITHUB_SEARCH_REQUEST_BUDGET, 300, 300);
const maximumPagesPerQuery = positiveInteger(process.env.GITHUB_SEARCH_PAGES_PER_QUERY, 10, 10);
const jpxNames = await readJpxNames(valueAfter("--jpx-csv"));
let requestsUsed = 0;
let metadataRequestsUsed = 0;
const metadataRequestBudget = positiveInteger(process.env.GITHUB_REPOSITORY_METADATA_BUDGET, 80, 200);
const repositoryCache = new Map<string, Promise<SearchRepository>>();
let truncated = false;
const candidates: TenantCandidateArtifactItem[] = [];

for (const query of githubTenantQueries()) {
  for (let page = 1; page <= maximumPagesPerQuery; page += 1) {
    if (requestsUsed >= requestBudget) {
      truncated = true;
      break;
    }
    const url = new URL("https://api.github.com/search/code");
    url.searchParams.set("q", query);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await githubFetch(url);
    requestsUsed += 1;
    const payload = await response.json() as { items?: SearchItem[]; incomplete_results?: boolean };
    const items = payload.items ?? [];
    if (payload.incomplete_results === true) truncated = true;
    for (const item of items) {
      const repository = await enrichedRepository(item.repository);
      candidates.push(...candidatesFromSearchItem({ ...item, ...(repository === undefined ? {} : { repository }) }, jpxNames));
    }
    if (items.length < 100) break;
    await delay(6_100);
  }
  if (requestsUsed >= requestBudget) break;
}
if (requestsUsed >= requestBudget) truncated = true;

const deduplicated = deduplicateArtifactCandidates(candidates);
const summary = Object.fromEntries([...Map.groupBy(deduplicated, (candidate) => candidate.sourceKind)]
  .map(([kind, values]) => [kind, values.length]));
const artifact = tenantCandidateArtifactSchema.parse({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  generator: "source-tenant-github-harvester-v1",
  requestBudget,
  requestsUsed,
  metadataRequestsUsed,
  truncated,
  candidates: deduplicated,
  summary,
});
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await replaceWithAtomicFile(outputPath, (temporaryPath) => fs.writeFile(
  temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600 },
));
await replaceWithAtomicFile(summaryPath, (temporaryPath) => fs.writeFile(
  temporaryPath, markdownSummary(artifact), { encoding: "utf8", mode: 0o600 },
));
process.stdout.write(`${JSON.stringify({ requestsUsed, metadataRequestsUsed, requestBudget, truncated,
  candidates: deduplicated.length, summary })}\n`);

function candidatesFromSearchItem(item: SearchItem, names: string[]): TenantCandidateArtifactItem[] {
  const repositoryUrl = safeUrl(item.repository?.html_url);
  const repositoryHomepage = safeCorporateUrl(item.repository?.homepage ?? undefined);
  const fragments = (item.text_matches ?? []).flatMap((match) => match.fragment === undefined ? [] : [match.fragment]);
  const repositoryCname = item.repository?.repositoryCname ?? (/(^|\/)CNAME$/i.test(item.path ?? item.name ?? "")
    ? hostnameFromCname(fragments.join("\n")) : undefined);
  const repositoryEvidence = {
    ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
  };
  const haystack = [item.repository?.full_name, item.repository?.name, item.repository?.description,
    repositoryHomepage, ...fragments].filter((value): value is string => typeof value === "string").join(" ");
  const jpxMatch = matchCompanyNameSignal(haystack, names);
  return candidatesFromText(fragments.join("\n"), repositoryEvidence).map((candidate) => {
    const repositoryMatches = repositoryMatchesTenant(item.repository?.full_name, candidate.tenantKey, jpxMatch);
    const corporateUrl = repositoryMatches ? repositoryHomepage
      ?? (repositoryCname === undefined ? undefined : `https://${repositoryCname}/`) : undefined;
    return {
    ...candidate,
    ...(repositoryMatches && repositoryHomepage !== undefined ? { repositoryHomepage } : {}),
    ...(repositoryMatches && repositoryCname !== undefined ? { repositoryCname } : {}),
    ...(corporateUrl === undefined ? {} : { officialReferrerUrl: corporateUrl,
      officialReferrerBasis: repositoryHomepage === undefined ? "repository_cname" as const : "repository_homepage" as const }),
    ...(jpxMatch === undefined ? {} : {
      companyName: candidate.companyName ?? jpxMatch,
      japanSignalBasis: "jpx_name_match" as const,
      japanSignalCompanyName: jpxMatch,
    }),
    evidence: { ...candidate.evidence, searchItemUrl: item.html_url ?? null,
      repositoryFullName: item.repository?.full_name ?? null },
  }; });
}

async function enrichedRepository(repository: SearchRepository | undefined): Promise<SearchRepository | undefined> {
  const fullName = repository?.full_name;
  if (repository === undefined || fullName === undefined || repository.homepage) return repository;
  if (metadataRequestsUsed >= metadataRequestBudget) return repository;
  const cached = repositoryCache.get(fullName);
  if (cached !== undefined) return cached;
  const pending = (async () => {
    try {
      const response = await githubCoreFetch(new URL(`https://api.github.com/repos/${fullName}`));
      metadataRequestsUsed += 1;
      if (!response.ok) return repository;
      const metadata = await response.json() as SearchRepository;
      let cname: string | undefined;
      if (!metadata.homepage && metadataRequestsUsed < metadataRequestBudget) {
        const cnameResponse = await githubCoreFetch(new URL(`https://api.github.com/repos/${fullName}/contents/CNAME`),
          "application/vnd.github.raw+json");
        metadataRequestsUsed += 1;
        if (cnameResponse.ok) cname = hostnameFromCname(await cnameResponse.text());
      }
      return { ...repository, ...metadata, ...(cname === undefined ? {} : { repositoryCname: cname }) };
    } catch { return repository; }
  })();
  repositoryCache.set(fullName, pending);
  return pending;
}

async function githubCoreFetch(url: URL, accept = "application/vnd.github+json"): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(60_000), headers: { authorization: `Bearer ${token}`, accept,
    "x-github-api-version": "2022-11-28", "user-agent": "JapanJobAgent/0.2 source tenant harvester" } });
}

function repositoryMatchesTenant(fullName: string | undefined, tenantKey: string, companyName: string | undefined): boolean {
  if (companyName !== undefined) return true;
  if (fullName === undefined) return false;
  const repositoryIdentity = fullName.split("/").map(normalizeRepositoryIdentity).filter((value) => value.length >= 4);
  const tenant = normalizeRepositoryIdentity(tenantKey.split("/").at(-1) ?? tenantKey);
  return tenant.length >= 4 && repositoryIdentity.some((value) => value.includes(tenant) || tenant.includes(value));
}

function normalizeRepositoryIdentity(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function githubFetch(url: URL): Promise<Response> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github.text-match+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "JapanJobAgent/0.2 source tenant harvester",
    } });
    if (response.ok) return response;
    if (![403, 429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
      throw new Error(`GitHub code search failed with HTTP ${response.status}`);
    }
    const resetAt = Number(response.headers.get("x-ratelimit-reset") ?? 0) * 1_000;
    const retryAfter = Number(response.headers.get("retry-after") ?? 0) * 1_000;
    await delay(Math.max(retryAfter, resetAt - Date.now() + 1_000, 2 ** attempt * 5_000));
  }
  throw new Error("GitHub code search retry budget exhausted");
}

async function readJpxNames(filename: string | undefined): Promise<string[]> {
  if (filename === undefined) return [];
  const input = await fs.readFile(path.resolve(filename), "utf8");
  const rows = parseCsv(input);
  const headerIndex = rows.findIndex((row) => row.some((cell) => /(?:issue|company).*name|name.*(?:issue|company)/i.test(cell)));
  if (headerIndex < 0) return [];
  const header = rows[headerIndex]!;
  const nameIndex = header.findIndex((cell) => /(?:issue|company).*name|name.*(?:issue|company)/i.test(cell));
  if (nameIndex < 0) return [];
  const names = new Set<string>();
  for (const row of rows.slice(headerIndex + 1)) {
    const value = row[nameIndex]?.trim();
    if (value !== undefined && value.length >= 3 && /[A-Za-z\u3000-\u30ff\u3400-\u9fff]/.test(value)) names.add(value);
  }
  return [...names];
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? "";
    if (character === '"') {
      if (quoted && input[index + 1] === '"') { cell += '"'; index += 1; } else quoted = !quoted;
    } else if (character === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(cell); if (row.some((value) => value !== "")) rows.push(row); row = []; cell = "";
    } else cell += character;
  }
  row.push(cell); if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function hostnameFromCname(value: string): string | undefined {
  return value.split(/\s+/).map((entry) => entry.trim().replace(/^https?:\/\//, "").replace(/\/$/, ""))
    .find((entry) => /^(?=.{4,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(entry));
}

function safeCorporateUrl(value: string | undefined): string | undefined {
  const url = safeUrl(value);
  if (url === undefined) return undefined;
  const parsed = new URL(url);
  return parsed.protocol === "https:" ? url : undefined;
}

function safeUrl(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  try { return new URL(value).toString(); } catch { return undefined; }
}

function markdownSummary(artifact: ReturnType<typeof tenantCandidateArtifactSchema.parse>): string {
  const rows = Object.entries(artifact.summary).sort().map(([kind, count]) => `| ${kind} | ${count} |`).join("\n");
  return `# Weekly source tenant discovery\n\nGenerated: ${artifact.generatedAt}\n\n`
    + `GitHub Search requests: ${artifact.requestsUsed}/${artifact.requestBudget}\n\n`
    + `GitHub repository metadata requests: ${artifact.metadataRequestsUsed ?? 0}\n\n`
    + `Artifact candidates: ${artifact.candidates.length}\n\nTruncated: ${artifact.truncated}\n\n`
    + `| Source | Candidates |\n|---|---:|\n${rows}\n\n`
    + "This report is discovery-only. The workflow does not write production data or verify a source.\n";
}

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`Expected integer between 1 and ${maximum}, received ${value}`);
  }
  return parsed;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
