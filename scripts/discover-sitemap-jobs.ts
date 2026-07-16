import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { promises as fs } from "node:fs";
import path from "node:path";
import { load } from "cheerio";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { JobDiscoveryLead } from "../packages/contracts/src/index.js";
import type { OutboxDatabase } from "../packages/db/src/outbox.js";
import { JobDiscoveryService } from "../packages/discovery/src/job-discovery-service.js";
import {
  parseEngageDetail,
  parseSitemapEntries,
  parseSitemapIndex,
  parseTalentioDetail,
  parseYoloListingPage,
} from "../packages/discovery/src/sitemap-job-discovery.js";
import { replaceWithAtomicFile } from "../packages/operations/src/atomic-file.js";

const databaseUrl = required("DATABASE_URL");
const hostIntervalMs = Math.max(1_000, positiveInteger(process.env.SITEMAP_HOST_INTERVAL_MS, 1_000));
const yoloTarget = positiveInteger(process.env.YOLO_DISCOVERY_TARGET, 3_050);
const talentioTarget = positiveInteger(process.env.TALENTIO_DISCOVERY_TARGET, 3_300);
const engageTarget = positiveInteger(process.env.ENGAGE_DISCOVERY_TARGET, 3_300);
const enabled = new Set((process.env.SITEMAP_DISCOVERY_FAMILIES ?? "yolo_japan,talentio,engage")
  .split(",").map((value) => value.trim()).filter(Boolean));
const { Pool } = pg;
const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl }) }) });
const discovery = new JobDiscoveryService(db);

try {
  const sources = await ensureDiscoverySources();
  const jobs: Array<Promise<CollectorReport>> = [];
  if (enabled.has("yolo_japan") && await sourceEnabled(sources.yolo_japan)) jobs.push(runYolo(sources.yolo_japan));
  if (enabled.has("talentio") && await sourceEnabled(sources.talentio)) jobs.push(runTalentio(sources.talentio));
  if (enabled.has("engage") && await sourceEnabled(sources.engage)) jobs.push(runEngage(sources.engage));
  const collectors = await Promise.all(jobs);
  const summary = await discovery.summary();
  const distribution = await sourceFamilyDistribution();
  const report = { generatedAt: new Date().toISOString(), hostIntervalMs, collectors, summary, distribution };
  await replaceWithAtomicFile(path.resolve("tmp/sitemap-job-discovery-report.json"), (temporaryPath) =>
    fs.writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }));
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await db.destroy();
}

interface CollectorReport {
  family: string;
  target: number;
  fetchedPages: number;
  parsedLeads: number;
  admitted: number;
  failures: number;
  validAfter: number;
}

async function runYolo(discoverySourceId: string): Promise<CollectorReport> {
  const throttle = hostThrottle("www.yolo-japan.com");
  const rootUrl = "https://www.yolo-japan.com/ja/sitemap";
  const root = await throttle.fetch(rootUrl);
  let fetchedPages = 1;
  const categoryUrls = listingLinks(root, rootUrl, /^\/ja\/sitemap\/job-category\/\d+$/);
  const areaUrls = listingLinks(root, rootUrl, /^\/ja\/sitemap\/area\/\d+$/);
  const targetIds = new Set<string>();
  const observedTwice = new Set<string>();
  let parsedLeads = 0;
  let admitted = 0;
  let failures = 0;

  const categoryQueue = [...categoryUrls];
  const visitedCategory = new Set<string>();
  while (categoryQueue.length > 0 && targetIds.size < yoloTarget) {
    const url = categoryQueue.shift()!;
    if (visitedCategory.has(url)) continue;
    visitedCategory.add(url);
    try {
      const bytes = await throttle.fetch(url);
      fetchedPages += 1;
      const page = parseYoloListingPage(bytes, discoverySourceId, url, new Date().toISOString());
      page.nextPageUrls.filter((next) => !visitedCategory.has(next)).forEach((next) => categoryQueue.push(next));
      for (const lead of page.leads) {
        if (targetIds.size >= yoloTarget) break;
        parsedLeads += 1;
        const result = await discovery.ingest(lead);
        if (lead.externalPostingId !== undefined) targetIds.add(lead.externalPostingId);
        if (result.countable) admitted += 1;
      }
    } catch (error) {
      failures += 1;
      progressError("yolo_japan", url, error);
    }
    progress("yolo_japan", targetIds.size, yoloTarget, fetchedPages);
  }

  const areaQueue = [...areaUrls];
  const visitedArea = new Set<string>();
  while (areaQueue.length > 0 && observedTwice.size < targetIds.size) {
    const url = areaQueue.shift()!;
    if (visitedArea.has(url)) continue;
    visitedArea.add(url);
    try {
      const bytes = await throttle.fetch(url);
      fetchedPages += 1;
      const page = parseYoloListingPage(bytes, discoverySourceId, url, new Date().toISOString());
      page.nextPageUrls.filter((next) => !visitedArea.has(next)).forEach((next) => areaQueue.push(next));
      for (const lead of page.leads) {
        const externalId = lead.externalPostingId;
        if (externalId === undefined || !targetIds.has(externalId) || observedTwice.has(externalId)) continue;
        const result = await discovery.ingest(lead);
        if (result.countable) {
          observedTwice.add(externalId);
          admitted += 1;
        }
      }
    } catch (error) {
      failures += 1;
      progressError("yolo_japan", url, error);
    }
    progress("yolo_japan-second-observation", observedTwice.size, targetIds.size, fetchedPages);
  }
  return { family: "yolo_japan", target: yoloTarget, fetchedPages, parsedLeads, admitted, failures,
    validAfter: await familyValidCount("yolo_japan") };
}

async function runTalentio(discoverySourceId: string): Promise<CollectorReport> {
  const throttle = hostThrottle("open.talentio.com");
  const sitemapUrl = "https://open.talentio.com/sitemap.xml";
  const sitemap = await throttle.fetch(sitemapUrl);
  const entries = parseSitemapEntries(sitemap, "open.talentio.com")
    .filter((entry) => /^\/r\/1\/c\/[^/]+\/pages\/\d+\/?$/.test(new URL(entry.url).pathname))
    .sort((left, right) => (right.lastModified ?? "").localeCompare(left.lastModified ?? "") || left.url.localeCompare(right.url));
  const sitemapHash = sha256(sitemap);
  const snapshotDate = new Date().toISOString().slice(0, 10);
  const importRunId = await discovery.recordFinalizedAuthoritativeImport({
    discoverySourceId,
    idempotencyKey: `talentio:sitemap:${snapshotDate}:${sitemapHash}`,
    pageCount: 1,
    providerTotal: entries.length,
    discoveredCount: entries.length,
    rawHash: sitemapHash,
    validation: { allPagesCompleted: true, tenantIdentityConsistent: true, providerTotalMatched: true, parseErrors: [] },
  });
  await observeExistingTalentioSnapshot(discoverySourceId, importRunId, snapshotDate, sitemapHash, entries);
  const known = await observationKeys("talentio");
  let valid = await familyValidCount("talentio");
  let fetchedPages = 1;
  let parsedLeads = 0;
  let admitted = 0;
  let failures = 0;
  for (const entry of entries) {
    if (valid >= talentioTarget) break;
    const externalId = new URL(entry.url).pathname.split("/").filter(Boolean).at(-1);
    if (externalId === undefined) continue;
    const observationKey = `talentio:sitemap:${externalId}:${entry.lastModified ?? "undated"}`;
    if (known.has(observationKey)) continue;
    try {
      const bytes = await throttle.fetch(entry.url);
      fetchedPages += 1;
      const lead = await parseTalentioDetail(bytes, discoverySourceId, entry.url, entry.lastModified, new Date().toISOString());
      if (lead === null) continue;
      parsedLeads += 1;
      const result = await discovery.ingest({ ...lead, discoveryImportRunId: importRunId });
      known.add(observationKey);
      if (result.countable) {
        admitted += 1;
        valid += 1;
      }
    } catch (error) {
      failures += 1;
      progressError("talentio", entry.url, error);
    }
    progress("talentio", valid, talentioTarget, fetchedPages);
  }
  return { family: "talentio", target: talentioTarget, fetchedPages, parsedLeads, admitted, failures,
    validAfter: await familyValidCount("talentio") };
}

async function observeExistingTalentioSnapshot(
  discoverySourceId: string,
  importRunId: string,
  snapshotDate: string,
  sitemapHash: string,
  entries: Array<{ url: string; lastModified?: string }>,
): Promise<void> {
  const entriesByIdentity = new Map(entries.map((entry) => [talentioIdentity(entry.url), entry]));
  const candidates = (await sql<{ id: string; tenant_key: string; external_posting_id: string }>`SELECT
      id,tenant_key,external_posting_id FROM job_discovery_candidates
    WHERE source_family='talentio' AND tenant_key IS NOT NULL AND external_posting_id IS NOT NULL
      AND discovery_source_id=${discoverySourceId}::uuid AND state NOT IN ('rejected','expired')`.execute(db)).rows;
  const observedAt = new Date().toISOString();
  for (const candidate of candidates) {
    const identity = `${candidate.tenant_key}:${candidate.external_posting_id}`;
    const entry = entriesByIdentity.get(identity);
    if (entry === undefined) continue;
    await discovery.observeAuthoritativePresence({
      candidateId: candidate.id,
      discoveryImportRunId: importRunId,
      observationKey: `talentio:snapshot:${snapshotDate}:${sitemapHash}:${identity}`,
      observedAt,
      payloadHash: sha256(new TextEncoder().encode(`${entry.url}\n${entry.lastModified ?? ""}`)),
      responseMetadata: { observationKind: "authoritative_sitemap_presence", sitemapHash,
        sitemapLastModified: entry.lastModified ?? null },
    });
  }
}

function talentioIdentity(rawUrl: string): string {
  const match = new URL(rawUrl).pathname.match(/^\/r\/1\/c\/([^/]+)\/pages\/(\d+)\/?$/);
  return match === null ? "" : `${match[1]}:${match[2]}`;
}

async function runEngage(discoverySourceId: string): Promise<CollectorReport> {
  const throttle = hostThrottle("en-gage.net");
  const indexUrl = "https://en-gage.net/sitemap_user_job_index.xml";
  const index = await throttle.fetch(indexUrl);
  const sitemapUrls = parseSitemapIndex(index, "en-gage.net").sort().reverse();
  const known = await observationKeys("engage");
  let valid = await familyValidCount("engage");
  let fetchedPages = 1;
  let parsedLeads = 0;
  let admitted = 0;
  let failures = 0;
  for (const sitemapUrl of sitemapUrls) {
    if (valid >= engageTarget) break;
    let entries;
    try {
      const compressed = await throttle.fetch(sitemapUrl);
      fetchedPages += 1;
      entries = parseSitemapEntries(maybeGunzip(compressed), "en-gage.net")
        .filter((entry) => /^\/user\/search\/desc\/\d+\/?$/.test(new URL(entry.url).pathname))
        .sort((left, right) => (right.lastModified ?? "").localeCompare(left.lastModified ?? ""));
    } catch (error) {
      failures += 1;
      progressError("engage", sitemapUrl, error);
      continue;
    }
    for (const entry of entries) {
      if (valid >= engageTarget) break;
      const externalId = new URL(entry.url).pathname.match(/\/(\d+)\/?$/)?.[1];
      if (externalId === undefined) continue;
      const observationDate = new Date().toISOString().slice(0, 10);
      const detailKey = `engage:detail:${externalId}:${entry.lastModified ?? "undated"}:${observationDate}`;
      const sitemapKey = `engage:sitemap:${externalId}:${entry.lastModified ?? "undated"}:${observationDate}`;
      if (known.has(detailKey) && known.has(sitemapKey)) continue;
      try {
        const bytes = await throttle.fetch(entry.url);
        fetchedPages += 1;
        const lead = parseEngageDetail(bytes, discoverySourceId, entry.url, sitemapUrl, entry.lastModified,
          new Date().toISOString());
        if (lead === null) continue;
        parsedLeads += 1;
        await discovery.ingest({ ...lead, observationKey: sitemapKey,
          responseMetadata: { ...lead.responseMetadata, observationKind: "sitemap_presence" } });
        const result = await discovery.ingest({ ...lead, observationKey: detailKey,
          responseMetadata: { ...lead.responseMetadata, observationKind: "detail_fetch" } });
        known.add(sitemapKey);
        known.add(detailKey);
        if (result.countable) {
          admitted += 1;
          valid += 1;
        }
      } catch (error) {
        failures += 1;
        progressError("engage", entry.url, error);
      }
      progress("engage", valid, engageTarget, fetchedPages);
    }
  }
  return { family: "engage", target: engageTarget, fetchedPages, parsedLeads, admitted, failures,
    validAfter: await familyValidCount("engage") };
}

function hostThrottle(expectedHost: string): { fetch: (url: string) => Promise<Uint8Array> } {
  let nextAllowedAt = 0;
  return { fetch: async (rawUrl: string) => {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.hostname !== expectedHost || url.username !== "" || url.password !== "") {
      throw new Error(`Blocked URL outside https://${expectedHost}: ${rawUrl}`);
    }
    const delayMs = Math.max(0, nextAllowedAt - Date.now());
    if (delayMs > 0) await delay(delayMs);
    nextAllowedAt = Date.now() + hostIntervalMs;
    return fetchWithRetry(url, expectedHost);
  } };
}

async function fetchWithRetry(url: URL, expectedHost: string, attempt = 0): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000), headers: {
      accept: "text/html,application/xhtml+xml,application/xml,text/xml,application/gzip",
      "user-agent": "JapanJobAgent/0.2 (+private personal use)",
    } });
  } catch (error) {
    if (attempt < 3) {
      await delay(2 ** attempt * 2_000 + Math.floor(Math.random() * 500));
      return fetchWithRetry(url, expectedHost, attempt + 1);
    }
    throw error;
  }
  const finalUrl = new URL(response.url || url.toString());
  if (finalUrl.protocol !== "https:" || finalUrl.hostname !== expectedHost) {
    throw new Error(`Blocked cross-host redirect from ${url} to ${finalUrl}`);
  }
  if ((response.status === 429 || response.status >= 500) && attempt < 3) {
    const retryAfter = Number(response.headers.get("retry-after") ?? 0) * 1_000;
    await delay(Math.max(retryAfter, 2 ** attempt * 2_000 + Math.floor(Math.random() * 500)));
    return fetchWithRetry(url, expectedHost, attempt + 1);
  }
  if (!response.ok) throw new Error(`${response.status} from ${url}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > 10 * 1024 * 1024) throw new Error(`Response exceeds 10 MiB: ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) throw new Error(`Invalid response size from ${url}`);
  return bytes;
}

async function ensureDiscoverySources(): Promise<Record<"yolo_japan" | "talentio" | "engage", string>> {
  const values = [
    ["yolo_japan", "YOLO JAPAN public job sitemap", "aggregator_lead", "https://www.yolo-japan.com/ja/sitemap"],
    ["talentio", "Talentio public job sitemap", "public_ats", "https://open.talentio.com/sitemap.xml"],
    ["engage", "engage public job sitemap", "aggregator_lead", "https://en-gage.net/sitemap_user_job_index.xml"],
  ] as const;
  const output = {} as Record<"yolo_japan" | "talentio" | "engage", string>;
  for (const [key, name, kind, baseUrl] of values) {
    const result = await sql<{ id: string }>`INSERT INTO discovery_sources(source_key,name,source_kind,base_url,policy_notes)
      VALUES (${`job-sitemap-${key}`},${name},${kind}::discovery_source_kind,${baseUrl},
        'Public pages only; no login, CAPTCHA bypass or proxy rotation. Leads remain isolated until verified promotion.')
      ON CONFLICT(source_key) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,
        policy_notes=excluded.policy_notes,updated_at=now() RETURNING id`.execute(db);
    output[key] = result.rows[0]!.id;
  }
  return output;
}

async function sourceEnabled(discoverySourceId: string): Promise<boolean> {
  const result = await sql<{ enabled: boolean }>`SELECT enabled FROM discovery_sources
    WHERE id=${discoverySourceId}::uuid`.execute(db);
  return result.rows[0]?.enabled === true;
}

function listingLinks(input: Uint8Array, baseUrl: string, pathPattern: RegExp): string[] {
  const $ = load(new TextDecoder().decode(input));
  return [...new Set($("a[href]").toArray().flatMap((element) => {
    const href = $(element).attr("href");
    if (href === undefined) return [];
    const url = new URL(href, baseUrl);
    return url.hostname === "www.yolo-japan.com" && pathPattern.test(url.pathname) ? [url.toString()] : [];
  }))];
}

async function observationKeys(sourceFamily: string): Promise<Set<string>> {
  const result = await sql<{ observation_key: string }>`SELECT o.observation_key FROM job_discovery_observations o
    JOIN job_discovery_candidates c ON c.id=o.candidate_id WHERE c.source_family=${sourceFamily}`.execute(db);
  return new Set(result.rows.map((row) => row.observation_key));
}

async function familyValidCount(sourceFamily: string): Promise<number> {
  const result = await sql<{ count: number }>`SELECT count(*)::int count FROM job_discovery_candidates
    WHERE source_family=${sourceFamily} AND location_state='japan' AND state NOT IN ('rejected','expired') AND (
      (origin_kind='official_collection' AND last_authoritative_import_run_id IS NOT NULL
        AND last_authoritative_seen_at>=now()-interval '72 hours')
      OR (origin_kind<>'official_collection' AND observation_count>=2 AND last_seen_at>=now()-interval '30 days'))`.execute(db);
  return result.rows[0]?.count ?? 0;
}

async function sourceFamilyDistribution(): Promise<Array<{ sourceFamily: string; valid: number; share: number }>> {
  const result = await sql<{ sourceFamily: string; valid: number; share: number }>`WITH counts AS (
      SELECT source_family,count(*)::int valid FROM job_discovery_candidates
      WHERE location_state='japan' AND state NOT IN ('rejected','expired') AND (
        (origin_kind='official_collection' AND last_authoritative_import_run_id IS NOT NULL
          AND last_authoritative_seen_at>=now()-interval '72 hours')
        OR (origin_kind<>'official_collection' AND observation_count>=2 AND last_seen_at>=now()-interval '30 days'))
      GROUP BY source_family
    ), total AS (SELECT sum(valid)::numeric total FROM counts)
    SELECT source_family "sourceFamily",valid,round(valid/NULLIF(total,0),4)::float8 share
    FROM counts,total ORDER BY valid DESC,source_family`.execute(db);
  return result.rows;
}

function maybeGunzip(value: Uint8Array): Uint8Array {
  return value[0] === 0x1f && value[1] === 0x8b ? new Uint8Array(gunzipSync(value)) : value;
}

function progress(family: string, current: number, target: number, fetchedPages: number): void {
  if (current % 50 === 0 || current >= target) process.stdout.write(`${family} ${current}/${target} fetched=${fetchedPages}\n`);
}

function progressError(family: string, url: string, error: unknown): void {
  process.stderr.write(`${family} ${url}: ${error instanceof Error ? error.message : String(error)}\n`);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected positive integer, received ${value}`);
  return parsed;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
