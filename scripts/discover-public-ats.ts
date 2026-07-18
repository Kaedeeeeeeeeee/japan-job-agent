import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { AshbyConnector, LeverConnector, SmartRecruitersConnector } from "../packages/connectors-public-ats/src/public-ats-connectors.js";
import { WorkdayConnector, workdayTenantKey } from "../packages/connectors-workday/src/workday-connector.js";
import type { SourceConnector, SourceInstanceRef } from "../packages/contracts/src/index.js";
import { ConnectorError } from "../packages/contracts/src/index.js";
import type { OutboxDatabase } from "../packages/db/src/outbox.js";
import { JobDiscoveryService } from "../packages/discovery/src/job-discovery-service.js";
import {
  collectPublicAtsDiscovery,
  publicAtsBaseUrl,
  type PublicAtsTenantSeed,
} from "../packages/discovery/src/public-ats-discovery.js";
import { replaceWithAtomicFile } from "../packages/operations/src/atomic-file.js";
import {
  discoveryBackfillWindow,
  evaluateLeadForBackfill,
} from "../packages/freshness/src/discovery-backfill-window.js";

const databaseUrl = required("DATABASE_URL");
const githubToken = process.env.GITHUB_TOKEN;
const maximumTenants = positiveInteger(process.env.PUBLIC_ATS_MAX_TENANTS, 2_500);
const hostIntervalMs = positiveInteger(process.env.PUBLIC_ATS_HOST_INTERVAL_MS, 1_000);
const backfillWindow = discoveryBackfillWindow(process.env.DISCOVERY_BACKFILL_DAYS);
const { Pool } = pg;
const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl }) }) });
const discovery = new JobDiscoveryService(db);
const atsFetch = rateLimitedFetch(hostIntervalMs);

try {
  const configured = await readSeeds(process.env.PUBLIC_ATS_TENANT_FILE ?? "config/public-ats-tenant-seeds.json");
  const registered = await registeredTenantSeeds();
  const existing = await existingCandidateSeeds();
  const discovered = githubToken === undefined ? [] : await discoverGithubTenants(githubToken);
  const availableSeeds = deduplicateSeeds([...configured, ...registered, ...existing, ...discovered]);
  await registerTenantSeeds(availableSeeds);
  const seeds = limitTenantSeeds(availableSeeds, maximumTenants);
  const sources = await ensureDiscoverySources();
  const grouped = Map.groupBy(seeds, (seed) => seed.kind);
  const results = await Promise.all((["smartrecruiters", "lever", "ashby", "workday"] as const).map(async (kind) => {
    if (!await sourceEnabled(sources[kind])) return [];
    const connector = connectorFor(kind, atsFetch);
    const rows = [];
    const tenantSeeds = grouped.get(kind) ?? [];
    let completed = 0;
    for (const seed of tenantSeeds) {
      const source: SourceInstanceRef = {
        id: randomUUID(), sourceKind: kind, tenantKey: seed.tenantKey, baseUrl: publicAtsBaseUrl(kind, seed.tenantKey),
      };
      try {
        const result = await withRetry(() => collectPublicAtsDiscovery(
          connector, source, seed, sources[kind], AbortSignal.timeout(120_000),
        ));
        const importRunId = result.snapshot.kind === "authoritative"
          ? await discovery.recordFinalizedAuthoritativeImport({
            discoverySourceId: sources[kind],
            idempotencyKey: `${kind}:${seed.tenantKey}:${new Date().toISOString().slice(0, 10)}:${snapshotFingerprint(result.snapshot.jobs)}`,
            pageCount: result.snapshot.pageCount,
            providerTotal: result.snapshot.providerTotal ?? null,
            discoveredCount: result.snapshot.jobs.length,
            rawHash: snapshotFingerprint(result.snapshot.jobs),
            validation: {
              allPagesCompleted: result.snapshot.validation.allPagesCompleted,
              tenantIdentityConsistent: result.snapshot.validation.tenantIdentityConsistent,
              providerTotalMatched: result.snapshot.validation.providerTotalMatched,
              parseErrors: [...result.snapshot.validation.parseErrors],
            },
          })
          : undefined;
        let inserted = 0;
        let eligibleLeads = 0;
        let excludedUnknownPublication = 0;
        let excludedOutsideWindow = 0;
        for (const lead of result.leads) {
          const windowDecision = evaluateLeadForBackfill(lead, backfillWindow);
          if (windowDecision !== null && !windowDecision.eligible) {
            if (windowDecision.reason === "publication_date_unknown") excludedUnknownPublication += 1;
            else excludedOutsideWindow += 1;
            continue;
          }
          eligibleLeads += 1;
          const persisted = await discovery.ingest({ ...lead, ...(importRunId === undefined ? {} : {
            discoveryImportRunId: importRunId,
            observationKey: `${lead.observationKey}:snapshot:${importRunId}`,
          }) });
          if (persisted.candidateCreated) inserted += 1;
        }
        rows.push({ kind, tenantKey: seed.tenantKey, snapshotKind: result.snapshot.kind,
          currentJobs: result.snapshot.jobs.length, japanLeads: result.leads.length, eligibleLeads, inserted,
          excludedUnknownPublication, excludedOutsideWindow,
          excludedNonJapan: result.excludedNonJapan, excludedUnknownLocation: result.excludedUnknownLocation });
      } catch (error) {
        rows.push({ kind, tenantKey: seed.tenantKey, snapshotKind: "failed", currentJobs: 0, japanLeads: 0,
          inserted: 0, excludedNonJapan: 0, excludedUnknownLocation: 0,
          error: error instanceof Error ? error.message : String(error) });
      }
      completed += 1;
      if (completed % 25 === 0 || completed === tenantSeeds.length) {
        process.stdout.write(`${kind} ${completed}/${tenantSeeds.length}\n`);
      }
      await delay(hostIntervalMs);
    }
    return rows;
  }));
  const summary = await discovery.summary();
  const report = { generatedAt: new Date().toISOString(), seedCount: seeds.length,
    publicationWindow: backfillWindow === null ? null : {
      days: backfillWindow.days, cutoffDate: backfillWindow.cutoffDate, today: backfillWindow.today,
    },
    sources: results.flat(), summary };
  await fs.mkdir(path.resolve("tmp"), { recursive: true });
  await replaceWithAtomicFile(path.resolve("tmp/public-ats-discovery-report.json"), (temporaryPath) =>
    fs.writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }));
  process.stdout.write(`${JSON.stringify({ seedCount: seeds.length, audited: results.flat().length, summary })}\n`);
} finally {
  await db.destroy();
}

async function ensureDiscoverySources(): Promise<Record<PublicAtsTenantSeed["kind"], string>> {
  const values: Array<[PublicAtsTenantSeed["kind"], string, string]> = [
    ["smartrecruiters", "SmartRecruiters public Posting API", "https://api.smartrecruiters.com/v1/companies/"],
    ["lever", "Lever public Postings API", "https://api.lever.co/v0/postings/"],
    ["ashby", "Ashby public Job Postings API", "https://api.ashbyhq.com/posting-api/job-board/"],
    ["workday", "Workday public CXS careers API", "https://www.myworkdayjobs.com/"],
  ];
  const output = {} as Record<PublicAtsTenantSeed["kind"], string>;
  for (const [kind, name, baseUrl] of values) {
    const result = await sql<{ id: string }>`INSERT INTO discovery_sources(source_key,name,source_kind,base_url,policy_notes)
      VALUES (${`public-ats-${kind}`},${name},'public_ats',${baseUrl},
        'Public listings only. Discovery candidates remain outside recommendations until verified promotion.')
      ON CONFLICT(source_key) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,
        policy_notes=excluded.policy_notes,updated_at=now() RETURNING id`.execute(db);
    output[kind] = result.rows[0]!.id;
  }
  return output;
}

async function sourceEnabled(discoverySourceId: string): Promise<boolean> {
  const result = await sql<{ enabled: boolean }>`SELECT enabled FROM discovery_sources
    WHERE id=${discoverySourceId}::uuid`.execute(db);
  return result.rows[0]?.enabled === true;
}

async function discoverGithubTenants(token: string): Promise<PublicAtsTenantSeed[]> {
  const hosts: Array<[PublicAtsTenantSeed["kind"], string]> = [
    ["smartrecruiters", "jobs.smartrecruiters.com/"],
    ["lever", "jobs.lever.co/"],
    ["ashby", "jobs.ashbyhq.com/"],
    ["workday", "myworkdayjobs.com/"],
  ];
  const output: PublicAtsTenantSeed[] = [];
  for (const [kind, host] of hosts) {
    for (let page = 1; page <= 10; page += 1) {
      const url = new URL("https://api.github.com/search/code");
      url.searchParams.set("q", `\"${host}\" in:file`);
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      const response = await fetch(url, { headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github.text-match+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "JapanJobAgent/0.2",
      } });
      if (response.status === 403 || response.status === 429) {
        const reset = Number(response.headers.get("x-ratelimit-reset") ?? 0) * 1_000;
        await delay(Math.max(2_000, reset - Date.now() + 1_000));
        page -= 1;
        continue;
      }
      if (!response.ok) throw new Error(`GitHub code search failed: ${response.status}`);
      const payload = await response.json() as { items?: Array<{ text_matches?: Array<{ fragment?: string }> }> };
      const items = payload.items ?? [];
      for (const item of items) {
        for (const match of item.text_matches ?? []) {
          if (match.fragment === undefined) continue;
          for (const tenantKey of tenantsFromText(kind, match.fragment)) output.push({ kind, tenantKey });
        }
      }
      if (items.length < 100) break;
      await delay(2_100);
    }
  }
  return output;
}

export function tenantsFromText(kind: PublicAtsTenantSeed["kind"], text: string): string[] {
  if (kind === "workday") {
    const pattern = /https?:\/\/([A-Za-z0-9-]+\.wd[0-9a-z-]*\.myworkdayjobs\.com)\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?([A-Za-z0-9._-]+)/g;
    return [...text.matchAll(pattern)].flatMap((match) => {
      const host = match[1];
      const site = match[2];
      return host === undefined || site === undefined || ["wday", "job"].includes(site.toLowerCase())
        ? [] : [`${host.toLowerCase()}/${site}`];
    });
  }
  const host = kind === "smartrecruiters" ? "jobs\\.smartrecruiters\\.com"
    : kind === "lever" ? "jobs\\.lever\\.co" : "jobs\\.ashbyhq\\.com";
  const pattern = new RegExp(`https?://${host}/([A-Za-z0-9._-]+)`, "g");
  return [...text.matchAll(pattern)].map((match) => match[1]).filter((value): value is string => value !== undefined)
    .filter((value) => !["api", "assets", "static"].includes(value.toLowerCase()));
}

function deduplicateSeeds(values: PublicAtsTenantSeed[]): PublicAtsTenantSeed[] {
  const output = new Map<string, PublicAtsTenantSeed>();
  for (const value of values) {
    if (value.kind === "workday" ? !/^[A-Za-z0-9-]+\.wd[0-9a-z-]*\.myworkdayjobs\.com\/[A-Za-z0-9._-]+$/i.test(value.tenantKey)
      : !/^[A-Za-z0-9._-]+$/.test(value.tenantKey)) continue;
    const key = `${value.kind}:${value.tenantKey.toLowerCase()}`;
    const current = output.get(key);
    if (current === undefined) {
      output.set(key, value);
      continue;
    }
    const companyName = current.companyName ?? value.companyName;
    const officialReferrerUrl = current.officialReferrerUrl ?? value.officialReferrerUrl;
    output.set(key, { ...value, ...(companyName === undefined ? {} : { companyName }),
      ...(officialReferrerUrl === undefined ? {} : { officialReferrerUrl }) });
  }
  return [...output.values()].sort((left, right) => Number(right.companyName !== undefined) - Number(left.companyName !== undefined)
    || left.kind.localeCompare(right.kind) || left.tenantKey.localeCompare(right.tenantKey));
}

export function limitTenantSeeds(values: PublicAtsTenantSeed[], maximum: number): PublicAtsTenantSeed[] {
  const kinds = ["smartrecruiters", "lever", "ashby", "workday"] as const;
  const perFamily = Math.ceil(maximum / kinds.length);
  return kinds.flatMap((kind) => values.filter((value) => value.kind === kind).slice(0, perFamily)).slice(0, maximum);
}

async function readSeeds(filename: string): Promise<PublicAtsTenantSeed[]> {
  try {
    return JSON.parse(await fs.readFile(path.resolve(filename), "utf8")) as PublicAtsTenantSeed[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function existingCandidateSeeds(): Promise<PublicAtsTenantSeed[]> {
  const result = await sql<{ kind: PublicAtsTenantSeed["kind"]; tenant_key: string; company_name: string }>`SELECT
      source_family kind,tenant_key,max(company_name) company_name
    FROM job_discovery_candidates
    WHERE source_family IN ('smartrecruiters','lever','ashby','workday') AND tenant_key IS NOT NULL
    GROUP BY source_family,tenant_key`.execute(db);
  return result.rows.map((row) => ({ kind: row.kind, tenantKey: row.tenant_key, companyName: row.company_name }));
}

async function registeredTenantSeeds(): Promise<PublicAtsTenantSeed[]> {
  const result = await sql<{ base_url: string }>`SELECT base_url FROM discovery_sources
    WHERE source_key LIKE 'public-ats-tenant-%' AND enabled=true ORDER BY source_key`.execute(db);
  return result.rows.flatMap((row) => {
    const parsed = tenantSeedFromBaseUrl(row.base_url);
    return parsed === null ? [] : [parsed];
  });
}

async function registerTenantSeeds(seeds: PublicAtsTenantSeed[]): Promise<void> {
  for (const seed of seeds) {
    const baseUrl = publicAtsBaseUrl(seed.kind, seed.tenantKey);
    await sql`INSERT INTO discovery_sources(source_key,name,source_kind,base_url,policy_notes)
      VALUES (${`public-ats-tenant-${seed.kind}-${seed.tenantKey.toLowerCase().replaceAll("/", "-")}`},
        ${`Public ATS tenant ${seed.kind}:${seed.tenantKey}`},'public_ats',${baseUrl},
        'Public tenant discovered from configured seeds, existing candidates, or public GitHub code. '
          || 'Jobs remain Discovery-only until an official company backlink verifies the exact tenant.')
      ON CONFLICT(source_key) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,updated_at=now()`
      .execute(db);
  }
}

function tenantSeedFromBaseUrl(rawUrl: string): PublicAtsTenantSeed | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  if (/^[a-z0-9-]+\.wd[0-9a-z-]*\.myworkdayjobs\.com$/i.test(url.hostname)) {
    try { return { kind: "workday", tenantKey: workdayTenantKey(rawUrl) }; } catch { return null; }
  }
  const tenantKey = url.pathname.split("/").filter(Boolean)[0];
  if (tenantKey === undefined || !/^[A-Za-z0-9._-]+$/.test(tenantKey)) return null;
  if (url.hostname === "jobs.smartrecruiters.com") return { kind: "smartrecruiters", tenantKey };
  if (url.hostname === "jobs.lever.co") return { kind: "lever", tenantKey };
  if (url.hostname === "jobs.ashbyhq.com") return { kind: "ashby", tenantKey };
  return null;
}

function connectorFor(kind: PublicAtsTenantSeed["kind"], fetchImplementation: typeof fetch): SourceConnector {
  return kind === "smartrecruiters" ? new SmartRecruitersConnector(fetchImplementation)
    : kind === "lever" ? new LeverConnector(fetchImplementation)
      : kind === "ashby" ? new AshbyConnector(fetchImplementation)
        : new WorkdayConnector(fetchImplementation, 8 * 1024 * 1024, "Japan");
}

async function withRetry<T>(operation: () => Promise<T>, attempt = 0): Promise<T> {
  try { return await operation(); } catch (error) {
    if (!(error instanceof ConnectorError) || !error.retryable || attempt >= 3) throw error;
    const base = 2 ** attempt * 2_000;
    await delay(base + Math.floor(Math.random() * 500));
    return withRetry(operation, attempt + 1);
  }
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function rateLimitedFetch(intervalMs: number): typeof fetch {
  const nextByHost = new Map<string, number>();
  return async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const wait = Math.max(0, (nextByHost.get(url.hostname) ?? 0) - Date.now());
    if (wait > 0) await delay(wait);
    nextByHost.set(url.hostname, Date.now() + intervalMs);
    return fetch(input, init);
  };
}

function snapshotFingerprint(jobs: readonly { identity: { stableKey: string }; rawHash?: string }[]): string {
  return createHash("sha256").update(jobs.map((job) => job.identity.stableKey).sort().join("\n")).digest("hex");
}
