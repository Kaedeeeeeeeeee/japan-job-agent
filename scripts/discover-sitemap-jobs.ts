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
import { engageEntryAction, parseEngageDiscoveryMode, type EngageDiscoveryMode } from "../packages/discovery/src/engage-discovery-mode.js";
import {
  parseEngageDetail,
  parseSitemapEntries,
  parseSitemapIndex,
  parseTalentioDetail,
  parseYoloListingPage,
  type SitemapEntry,
} from "../packages/discovery/src/sitemap-job-discovery.js";
import { parsePublishedDateValue } from "../packages/freshness/src/job-freshness.js";
import { replaceWithAtomicFile } from "../packages/operations/src/atomic-file.js";
import { normalizeApplicationUrl } from "../packages/canonical/src/normalize-application-url.js";
import {
  discoveryBackfillWindow,
  evaluateLeadForBackfill,
} from "../packages/freshness/src/discovery-backfill-window.js";

const databaseUrl = required("DATABASE_URL");
const hostIntervalMs = Math.max(125, positiveInteger(process.env.SITEMAP_HOST_INTERVAL_MS, 1_000));
const yoloMaxListingsPerRun = positiveInteger(
  process.env.YOLO_DISCOVERY_MAX_LISTINGS_PER_RUN ?? process.env.YOLO_DISCOVERY_TARGET,
  10_000,
);
const talentioMaxDetailsPerRun = positiveInteger(
  process.env.TALENTIO_DISCOVERY_MAX_DETAILS_PER_RUN ?? process.env.TALENTIO_DISCOVERY_TARGET,
  5_000,
);
const engageMaxDetailsPerRun = positiveInteger(
  process.env.ENGAGE_DISCOVERY_MAX_DETAILS_PER_RUN ?? process.env.ENGAGE_DISCOVERY_TARGET,
  5_000,
);
const engageDetailConcurrency = Math.min(8, positiveInteger(process.env.ENGAGE_DISCOVERY_CONCURRENCY, 1));
const engageDiscoveryMode = parseEngageDiscoveryMode(process.env.ENGAGE_DISCOVERY_MODE);
const engageMaxSitemapFiles = positiveInteger(process.env.ENGAGE_SITEMAP_MAX_FILES_PER_RUN, 10_000);
const enabled = new Set((process.env.SITEMAP_DISCOVERY_FAMILIES ?? "yolo_japan,talentio,engage")
  .split(",").map((value) => value.trim()).filter(Boolean));
const backfillWindow = discoveryBackfillWindow(process.env.DISCOVERY_BACKFILL_DAYS);
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
  const report = { generatedAt: new Date().toISOString(), hostIntervalMs,
    publicationWindow: backfillWindow === null ? null : {
      days: backfillWindow.days, cutoffDate: backfillWindow.cutoffDate, today: backfillWindow.today,
    },
    collectors, summary, distribution };
  await replaceWithAtomicFile(path.resolve("tmp/sitemap-job-discovery-report.json"), (temporaryPath) =>
    fs.writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }));
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await db.destroy();
}

interface CollectorReport {
  family: string;
  discoveryMode?: EngageDiscoveryMode;
  maximumPerRun: number;
  concurrency?: number;
  processed: number;
  fetchedPages: number;
  parsedLeads: number;
  admitted: number;
  created: number;
  excludedUnknownPublication: number;
  excludedOutsideWindow: number;
  prefilteredBySitemapLastModified: number;
  failures: number;
  validAfter: number;
}

interface WindowExclusions {
  unknownPublication: number;
  outsideWindow: number;
}

async function runYolo(discoverySourceId: string): Promise<CollectorReport> {
  const throttle = hostThrottle("www.yolo-japan.com");
  const rootUrl = "https://www.yolo-japan.com/ja/sitemap";
  const root = await throttle.fetch(rootUrl);
  let fetchedPages = 1;
  const categoryUrls = listingLinks(root, rootUrl, /^\/ja\/sitemap\/job-category\/\d+$/);
  const areaUrls = listingLinks(root, rootUrl, /^\/ja\/sitemap\/area\/\d+$/);
  const targetIds = new Set<string>();
  const existingDatedIds = backfillWindow === null ? new Set<string>() : await datedExternalPostingIds("yolo_japan");
  const observedTwice = new Set<string>();
  let parsedLeads = 0;
  let admitted = 0;
  let created = 0;
  const excluded: WindowExclusions = { unknownPublication: 0, outsideWindow: 0 };
  let failures = 0;

  const categoryQueue = [...categoryUrls];
  const visitedCategory = new Set<string>();
  while (categoryQueue.length > 0 && targetIds.size < yoloMaxListingsPerRun) {
    const url = categoryQueue.shift()!;
    if (visitedCategory.has(url)) continue;
    visitedCategory.add(url);
    try {
      const bytes = await throttle.fetch(url);
      fetchedPages += 1;
      const page = parseYoloListingPage(bytes, discoverySourceId, url, new Date().toISOString());
      page.nextPageUrls.filter((next) => !visitedCategory.has(next)).forEach((next) => categoryQueue.push(next));
      for (const lead of page.leads) {
        if (targetIds.size >= yoloMaxListingsPerRun) break;
        parsedLeads += 1;
        if (lead.externalPostingId !== undefined && existingDatedIds.has(lead.externalPostingId)) continue;
        if (excludeFromBackfill(lead, excluded)) continue;
        const result = await discovery.ingest(lead);
        if (result.candidateCreated) created += 1;
        if (lead.externalPostingId !== undefined && result.disposition !== "tombstoned") {
          targetIds.add(lead.externalPostingId);
          existingDatedIds.add(lead.externalPostingId);
        }
        if (result.countable) admitted += 1;
      }
    } catch (error) {
      failures += 1;
      progressError("yolo_japan", url, error);
    }
    progress("yolo_japan", targetIds.size, yoloMaxListingsPerRun, fetchedPages);
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
  return { family: "yolo_japan", maximumPerRun: yoloMaxListingsPerRun, processed: targetIds.size,
    fetchedPages, parsedLeads, admitted, created,
    excludedUnknownPublication: excluded.unknownPublication, excludedOutsideWindow: excluded.outsideWindow,
    prefilteredBySitemapLastModified: 0, failures,
    validAfter: await familyValidCount("yolo_japan") };
}

async function runTalentio(discoverySourceId: string): Promise<CollectorReport> {
  const throttle = hostThrottle("open.talentio.com");
  const sitemapUrl = "https://open.talentio.com/sitemap.xml";
  const sitemap = await throttle.fetch(sitemapUrl);
  const allEntries = parseSitemapEntries(sitemap, "open.talentio.com")
    .filter((entry) => /^\/r\/1\/c\/[^/]+\/pages\/\d+\/?$/.test(new URL(entry.url).pathname))
    .sort((left, right) => (right.lastModified ?? "").localeCompare(left.lastModified ?? "") || left.url.localeCompare(right.url));
  const entries = allEntries.filter(sitemapEntryMayBeInBackfill);
  const prefilteredBySitemapLastModified = allEntries.length - entries.length;
  const sitemapHash = sha256(sitemap);
  const snapshotDate = new Date().toISOString().slice(0, 10);
  const importRunId = await discovery.recordFinalizedAuthoritativeImport({
    discoverySourceId,
    idempotencyKey: `talentio:sitemap:${snapshotDate}:${sitemapHash}`,
    pageCount: 1,
    providerTotal: allEntries.length,
    discoveredCount: allEntries.length,
    rawHash: sitemapHash,
    validation: { allPagesCompleted: true, tenantIdentityConsistent: true, providerTotalMatched: true, parseErrors: [] },
  });
  await observeExistingTalentioSnapshot(discoverySourceId, importRunId, snapshotDate, sitemapHash, allEntries);
  const known = await observationKeys("talentio");
  const tombstones = await retentionDetailUrlHashes();
  let valid = await familyValidCount("talentio");
  let fetchedPages = 1;
  let parsedLeads = 0;
  let admitted = 0;
  let created = 0;
  const excluded: WindowExclusions = { unknownPublication: 0, outsideWindow: 0 };
  let failures = 0;
  let processed = 0;
  for (const entry of entries) {
    if (processed >= talentioMaxDetailsPerRun) break;
    const externalId = new URL(entry.url).pathname.split("/").filter(Boolean).at(-1);
    if (externalId === undefined) continue;
    if (tombstones.has(detailUrlHash(entry.url))) continue;
    const observationKey = `talentio:sitemap:${externalId}:${entry.lastModified ?? "undated"}`;
    if (known.has(observationKey)) continue;
    try {
      processed += 1;
      const bytes = await throttle.fetch(entry.url);
      fetchedPages += 1;
      const lead = await parseTalentioDetail(bytes, discoverySourceId, entry.url, entry.lastModified, new Date().toISOString());
      if (lead === null) continue;
      parsedLeads += 1;
      if (excludeFromBackfill(lead, excluded)) continue;
      const result = await discovery.ingest({ ...lead, discoveryImportRunId: importRunId });
      if (result.candidateCreated) created += 1;
      known.add(observationKey);
      if (result.countable) {
        admitted += 1;
        valid += 1;
      }
    } catch (error) {
      failures += 1;
      progressError("talentio", entry.url, error);
    }
    progress("talentio-new-details", processed, talentioMaxDetailsPerRun, fetchedPages);
  }
  return { family: "talentio", maximumPerRun: talentioMaxDetailsPerRun, processed,
    fetchedPages, parsedLeads, admitted, created,
    excludedUnknownPublication: excluded.unknownPublication, excludedOutsideWindow: excluded.outsideWindow,
    prefilteredBySitemapLastModified, failures,
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
      AND discovery_source_id=${discoverySourceId}::uuid AND state NOT IN ('rejected','expired')
      AND publication_freshness='recent'`.execute(db)).rows;
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
  if (engageDiscoveryMode === "pause_new") {
    return observeExistingEngageSitemaps(sitemapUrls, throttle);
  }
  const known = await observationKeys("engage");
  const existingDatedIds = backfillWindow === null ? new Set<string>() : await datedExternalPostingIds("engage");
  const tombstones = await retentionDetailUrlHashes();
  let valid = await familyValidCount("engage");
  let fetchedPages = 1;
  let parsedLeads = 0;
  let admitted = 0;
  let created = 0;
  const excluded: WindowExclusions = { unknownPublication: 0, outsideWindow: 0 };
  let failures = 0;
  let processed = 0;
  let prefilteredBySitemapLastModified = 0;
  for (const sitemapUrl of sitemapUrls) {
    if (processed >= engageMaxDetailsPerRun) break;
    let entries;
    try {
      const compressed = await throttle.fetch(sitemapUrl);
      fetchedPages += 1;
      const allEntries = parseSitemapEntries(maybeGunzip(compressed), "en-gage.net")
        .filter((entry) => /^\/user\/search\/desc\/\d+\/?$/.test(new URL(entry.url).pathname))
        .sort((left, right) => (right.lastModified ?? "").localeCompare(left.lastModified ?? ""));
      entries = allEntries.filter(sitemapEntryMayBeInBackfill);
      prefilteredBySitemapLastModified += allEntries.length - entries.length;
    } catch (error) {
      failures += 1;
      progressError("engage", sitemapUrl, error);
      continue;
    }
    const work: Array<{ entry: SitemapEntry; detailKey: string; sitemapKey: string; sequence: number }> = [];
    for (const entry of entries) {
      if (processed + work.length >= engageMaxDetailsPerRun) break;
      const externalId = new URL(entry.url).pathname.match(/\/(\d+)\/?$/)?.[1];
      if (externalId === undefined) continue;
      if (tombstones.has(detailUrlHash(entry.url))) continue;
      if (existingDatedIds.has(externalId)) continue;
      const observationDate = new Date().toISOString().slice(0, 10);
      const detailKey = `engage:detail:${externalId}:${entry.lastModified ?? "undated"}:${observationDate}`;
      const sitemapKey = `engage:sitemap:${externalId}:${entry.lastModified ?? "undated"}:${observationDate}`;
      if (known.has(detailKey) && known.has(sitemapKey)) continue;
      work.push({ entry, detailKey, sitemapKey, sequence: processed + work.length + 1 });
    }
    processed += work.length;
    await mapWithConcurrency(work, engageDetailConcurrency, async ({ entry, detailKey, sitemapKey, sequence }) => {
      try {
        const bytes = await throttle.fetch(entry.url);
        fetchedPages += 1;
        const lead = parseEngageDetail(bytes, discoverySourceId, entry.url, sitemapUrl, entry.lastModified,
          new Date().toISOString());
        if (lead === null) return;
        parsedLeads += 1;
        if (excludeFromBackfill(lead, excluded)) return;
        const sitemapResult = await discovery.ingest({ ...lead, observationKey: sitemapKey,
          responseMetadata: { ...lead.responseMetadata, observationKind: "sitemap_presence" } });
        const result = await discovery.ingest({ ...lead, observationKey: detailKey,
          responseMetadata: { ...lead.responseMetadata, observationKind: "detail_fetch" } });
        if (sitemapResult.candidateCreated || result.candidateCreated) created += 1;
        if (lead.externalPostingId !== undefined && result.disposition !== "tombstoned") {
          existingDatedIds.add(lead.externalPostingId);
        }
        known.add(sitemapKey);
        known.add(detailKey);
        if (result.countable) {
          admitted += 1;
          valid += 1;
        }
      } catch (error) {
        failures += 1;
        progressError("engage", entry.url, error);
      } finally {
        progress("engage-new-details", sequence, engageMaxDetailsPerRun, fetchedPages);
      }
    });
  }
  return { family: "engage", discoveryMode: engageDiscoveryMode, maximumPerRun: engageMaxDetailsPerRun, concurrency: engageDetailConcurrency, processed,
    fetchedPages, parsedLeads, admitted, created,
    excludedUnknownPublication: excluded.unknownPublication, excludedOutsideWindow: excluded.outsideWindow,
    prefilteredBySitemapLastModified, failures,
    validAfter: await familyValidCount("engage") };
}

async function observeExistingEngageSitemaps(
  sitemapUrls: string[],
  throttle: { fetch: (url: string) => Promise<Uint8Array> },
): Promise<CollectorReport> {
  const existing = await engageCandidateIds();
  const observedAt = new Date().toISOString();
  const observationDate = observedAt.slice(0, 10);
  let fetchedPages = 1;
  let processed = 0;
  let admitted = 0;
  let failures = 0;
  for (const sitemapUrl of sitemapUrls.slice(0, engageMaxSitemapFiles)) {
    try {
      const compressed = await throttle.fetch(sitemapUrl);
      fetchedPages += 1;
      const entries = parseSitemapEntries(maybeGunzip(compressed), "en-gage.net")
        .filter((entry) => /^\/user\/search\/desc\/\d+\/?$/.test(new URL(entry.url).pathname));
      for (const entry of entries) {
        const externalId = new URL(entry.url).pathname.match(/\/(\d+)\/?$/)?.[1];
        if (externalId === undefined) continue;
        const candidateId = existing.get(externalId);
        if (engageEntryAction("pause_new", candidateId !== undefined) !== "observe_existing" || candidateId === undefined) continue;
        processed += 1;
        const created = await discovery.observePresence({
          candidateId,
          observationKey: `engage:sitemap-presence:${externalId}:${entry.lastModified ?? "undated"}:${observationDate}`,
          observedAt,
          payloadHash: sha256(new TextEncoder().encode(`${entry.url}\n${entry.lastModified ?? ""}`)),
          responseMetadata: { observationKind: "sitemap_presence_pause_new", sitemapUrl,
            sitemapLastModified: entry.lastModified ?? null, discoveryMode: "pause_new" },
        });
        if (created) admitted += 1;
      }
    } catch (error) {
      failures += 1;
      progressError("engage-pause-new", sitemapUrl, error);
    }
    progress("engage-existing-sitemap-observations", processed, existing.size, fetchedPages);
  }
  return { family: "engage", discoveryMode: "pause_new", maximumPerRun: 0, concurrency: 1, processed,
    fetchedPages, parsedLeads: 0, admitted, created: 0, excludedUnknownPublication: 0,
    excludedOutsideWindow: 0, prefilteredBySitemapLastModified: 0, failures,
    validAfter: await familyValidCount("engage") };
}

async function engageCandidateIds(): Promise<Map<string, string>> {
  const result = await sql<{ id: string; external_posting_id: string }>`SELECT id,external_posting_id
    FROM job_discovery_candidates WHERE source_family='engage' AND external_posting_id IS NOT NULL
      AND state NOT IN ('rejected','expired')
      AND content_purged_at IS NULL`.execute(db);
  return new Map(result.rows.map((row) => [row.external_posting_id, row.id]));
}

function excludeFromBackfill(lead: JobDiscoveryLead, counts: WindowExclusions): boolean {
  const decision = evaluateLeadForBackfill(lead, backfillWindow);
  if (decision === null || decision.eligible) return false;
  if (decision.reason === "publication_date_unknown") counts.unknownPublication += 1;
  else counts.outsideWindow += 1;
  return true;
}

function sitemapEntryMayBeInBackfill(entry: SitemapEntry): boolean {
  if (backfillWindow === null || entry.lastModified === undefined) return true;
  const published = parsePublishedDateValue(entry.lastModified);
  if (published === undefined) return true;
  const decision = evaluateLeadForBackfill({ published }, backfillWindow);
  return decision?.reason !== "published_before_lookback_window";
}

async function datedExternalPostingIds(sourceFamily: string): Promise<Set<string>> {
  const result = await sql<{ external_posting_id: string }>`SELECT external_posting_id
    FROM job_discovery_candidates WHERE source_family=${sourceFamily} AND external_posting_id IS NOT NULL
      AND content_purged_at IS NULL AND source_published_precision IS NOT NULL`.execute(db);
  return new Set(result.rows.map((row) => row.external_posting_id));
}

function hostThrottle(expectedHost: string): { fetch: (url: string) => Promise<Uint8Array> } {
  let nextAllowedAt = 0;
  let startQueue = Promise.resolve();
  return { fetch: async (rawUrl: string) => {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.hostname !== expectedHost || url.username !== "" || url.password !== "") {
      throw new Error(`Blocked URL outside https://${expectedHost}: ${rawUrl}`);
    }
    const start = startQueue.then(async () => {
      const delayMs = Math.max(0, nextAllowedAt - Date.now());
      if (delayMs > 0) await delay(delayMs);
      nextAllowedAt = Date.now() + hostIntervalMs;
    });
    startQueue = start.catch(() => undefined);
    await start;
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
  const bytes = new Uint8Array(await responseBodyWithTimeout(response, url, 60_000));
  if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) throw new Error(`Invalid response size from ${url}`);
  return bytes;
}

async function responseBodyWithTimeout(response: Response, url: URL, timeoutMs: number): Promise<ArrayBuffer> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      response.arrayBuffer(),
      new Promise<ArrayBuffer>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Response body timeout from ${url}`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    void response.body?.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
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

async function retentionDetailUrlHashes(): Promise<Set<string>> {
  const result = await sql<{ normalized_detail_url_hash: string }>`SELECT normalized_detail_url_hash
    FROM job_retention_tombstones`.execute(db);
  return new Set(result.rows.map((row) => row.normalized_detail_url_hash));
}

function detailUrlHash(rawUrl: string): string {
  return createHash("sha256").update(normalizeApplicationUrl(rawUrl)).digest("hex");
}

async function familyValidCount(sourceFamily: string): Promise<number> {
  const result = await sql<{ count: number }>`SELECT count(*)::int count FROM job_discovery_candidates
    WHERE source_family=${sourceFamily} AND location_state='japan' AND state NOT IN ('rejected','expired')
      AND publication_freshness='recent' AND (
      (origin_kind='official_collection' AND last_authoritative_import_run_id IS NOT NULL
        AND last_authoritative_seen_at>=now()-interval '72 hours')
      OR (origin_kind<>'official_collection' AND observation_count>=2 AND last_seen_at>=now()-interval '30 days'))`.execute(db);
  return result.rows[0]?.count ?? 0;
}

async function sourceFamilyDistribution(): Promise<Array<{ sourceFamily: string; valid: number; share: number }>> {
  const result = await sql<{ sourceFamily: string; valid: number; share: number }>`WITH counts AS (
      SELECT source_family,count(*)::int valid FROM job_discovery_candidates
      WHERE location_state='japan' AND state NOT IN ('rejected','expired') AND publication_freshness='recent' AND (
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
  if ((current > 0 && current % 50 === 0) || current >= target) {
    process.stdout.write(`${family} ${current}/${target} fetched=${fetchedPages}\n`);
  }
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
async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const value = values[nextIndex];
      nextIndex += 1;
      if (value !== undefined) await task(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
}
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
