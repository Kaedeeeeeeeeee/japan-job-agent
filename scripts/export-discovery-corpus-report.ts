import { promises as fs } from "node:fs";
import path from "node:path";
import pg from "pg";

interface CandidateRow {
  id: string;
  state: string;
  source_family: string;
  company_name: string;
  title: string;
  location_text: string;
  priority: string;
  source_published_precision: string | null;
  publication_freshness: "recent" | "unknown_quarantine" | "expired";
  resolved_source_instance_id: string | null;
}

const databaseUrl = required("DATABASE_URL");
const reportDate = process.env.REPORT_DATE ?? tokyoDate(new Date());
const { Client } = pg;
const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  const candidates = await client.query<CandidateRow>(`SELECT id,state,source_family,company_name,title,location_text,
      priority,source_published_precision,publication_freshness,resolved_source_instance_id
    FROM job_discovery_candidates
    WHERE location_state='japan' AND state NOT IN ('rejected','expired') AND publication_freshness='recent' AND (
      (origin_kind='official_collection' AND last_authoritative_import_run_id IS NOT NULL
        AND last_authoritative_seen_at>=now()-interval '72 hours')
      OR (origin_kind<>'official_collection' AND observation_count>=2 AND last_seen_at>=now()-interval '30 days'))`);
  const stateRows = await client.query<{ state: string; count: number }>(`SELECT state,count(*)::int count
    FROM job_discovery_candidates GROUP BY state ORDER BY state`);
  const terminal = await client.query<{ total: number; rejected: number; expired: number }>(`SELECT count(*)::int total,
    count(*) FILTER(WHERE state='rejected')::int rejected,count(*) FILTER(WHERE state='expired')::int expired
    FROM job_discovery_candidates`);
  const duplicates = await client.query<{ external_keys: number; detail_urls: number; official_urls: number }>(`SELECT
    (SELECT count(*)::int FROM (SELECT source_family,tenant_key,external_posting_id
      FROM job_discovery_candidates WHERE tenant_key IS NOT NULL AND external_posting_id IS NOT NULL
      GROUP BY 1,2,3 HAVING count(*)>1) duplicate_external) external_keys,
    (SELECT count(*)::int FROM (SELECT normalized_detail_url FROM job_discovery_candidates
      GROUP BY 1 HAVING count(*)>1) duplicate_detail) detail_urls,
    (SELECT count(*)::int FROM (SELECT normalized_official_url FROM job_discovery_candidates
      WHERE normalized_official_url IS NOT NULL GROUP BY 1 HAVING count(*)>1) duplicate_official) official_urls`);
  const sourceFamilies = counts(candidates.rows, (row) => row.source_family).map(([name, count]) => ({
    name, count, share: fraction(count, candidates.rows.length),
  }));
  const priorities = counts(candidates.rows, (row) => row.priority).map(([name, count]) => ({ name, count }));
  const industries = counts(candidates.rows, (row) => industryBucket(`${row.company_name}\n${row.title}`))
    .map(([name, count]) => ({ name, count }));
  const locations = counts(candidates.rows, (row) => locationBucket(row.location_text))
    .map(([name, count]) => ({ name, count }));
  const companies = counts(candidates.rows, (row) => row.company_name).slice(0, 50)
    .map(([name, count]) => ({ name, count }));
  const publishedKnown = candidates.rows.filter((row) => row.source_published_precision !== null).length;
  const officialExitResolved = candidates.rows.filter((row) => row.resolved_source_instance_id !== null
    || row.state === "promoted").length;
  const payload = {
    generatedAt: new Date().toISOString(),
    reportDate,
    validCandidates: candidates.rows.length,
    sourceFamilies,
    states: stateRows.rows,
    priorities,
    industries,
    locations,
    topCompanies: companies,
    dates: { publishedKnown, publishedUnknown: candidates.rows.length - publishedKnown,
      unknownRate: fraction(candidates.rows.length - publishedKnown, candidates.rows.length) },
    freshness: { policyVersion: "published-six-calendar-months-v1", retentionMonths: 6,
      recent: candidates.rows.filter((row) => row.publication_freshness === "recent").length },
    officialExit: { resolved: officialExitResolved, unresolved: candidates.rows.length - officialExitResolved,
      resolutionRate: fraction(officialExitResolved, candidates.rows.length) },
    duplicates: duplicates.rows[0] ?? { external_keys: 0, detail_urls: 0, official_urls: 0 },
    terminal: terminal.rows[0] ?? { total: 0, rejected: 0, expired: 0 },
  };
  await fs.mkdir(path.resolve("config"), { recursive: true });
  await fs.mkdir(path.resolve("docs/delivery"), { recursive: true });
  await fs.writeFile(path.resolve(`config/discovery-corpus-audit-${reportDate}.json`),
    `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const sourceRows = sourceFamilies.map((row) => `| ${row.name} | ${row.count} | ${(row.share * 100).toFixed(2)}% |`).join("\n");
  const industryRows = industries.map((row) => `| ${row.name} | ${row.count} |`).join("\n");
  const locationRows = locations.slice(0, 30).map((row) => `| ${row.name} | ${row.count} |`).join("\n");
  const markdown = `# Discovery corpus audit — ${reportDate}

Valid job-level candidates: **${payload.validCandidates.toLocaleString("en-US")}**. Published date unknown rate: **${(payload.dates.unknownRate * 100).toFixed(2)}%**. Official-exit resolution rate: **${(payload.officialExit.resolutionRate * 100).toFixed(2)}%**.

## Source families

| Family | Valid candidates | Share |
|---|---:|---:|
${sourceRows}

## Deterministic industry buckets

| Bucket | Candidates |
|---|---:|
${industryRows}

## Japan location buckets

| Location | Candidates |
|---|---:|
${locationRows}

Strong duplicate groups: external ID ${payload.duplicates.external_keys}, detail URL ${payload.duplicates.detail_urls}, official URL ${payload.duplicates.official_urls}. Rejected: ${payload.terminal.rejected}; expired: ${payload.terminal.expired}. Industry and location buckets are deterministic reporting classifications only and do not affect recommendation scores or promotion eligibility.
`;
  await fs.writeFile(path.resolve(`docs/delivery/discovery-corpus-expansion-${reportDate}.md`), markdown);
  process.stdout.write(`${JSON.stringify({ validCandidates: payload.validCandidates,
    maximumSourceShare: sourceFamilies[0]?.share ?? 0, publishedUnknown: payload.dates.publishedUnknown,
    officialExitResolved, duplicates: payload.duplicates })}\n`);
} finally {
  await client.end();
}

function counts<T>(values: T[], key: (value: T) => string): Array<[string, number]> {
  const output = new Map<string, number>();
  for (const value of values) output.set(key(value), (output.get(key(value)) ?? 0) + 1);
  return [...output.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "ja"));
}

function industryBucket(value: string): string {
  if (/software|engineer|developer|product|web|AI|machine learning|data|e.?commerce|IT|システム|エンジニア|開発|プロダクト/i.test(value)) return "IT・Web・AI・EC";
  if (/consult|human resources|recruit|talent|人事|採用|コンサル/i.test(value)) return "ITコンサル・HR・人事";
  if (/製造|工場|機械|電機|自動車|manufactur/i.test(value)) return "製造";
  if (/銀行|証券|保険|金融|financ|bank/i.test(value)) return "金融";
  if (/小売|販売|店舗|retail|store/i.test(value)) return "小売";
  if (/物流|倉庫|配送|運送|logistics/i.test(value)) return "物流";
  if (/ホテル|宿泊|観光|旅館|hospitality/i.test(value)) return "ホテル・観光";
  if (/介護|看護|福祉|care|nurs/i.test(value)) return "介護・医療";
  return "その他";
}

function locationBucket(value: string): string {
  const prefecture = value.match(/(北海道|東京都|大阪府|京都府|.{2,3}県)/)?.[1];
  if (prefecture !== undefined) return prefecture.trim();
  if (/Japan remote|日本全国|国内.*リモート|全国.*リモート/i.test(value)) return "日本国内リモート";
  return "日本・都道府県未分類";
}

function fraction(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round(numerator / denominator * 1_000_000) / 1_000_000;
}

function tokyoDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(value);
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}
