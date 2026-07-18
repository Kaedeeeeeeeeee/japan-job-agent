import { promises as fs } from "node:fs";
import path from "node:path";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { OutboxDatabase } from "../packages/db/src/outbox.js";
import { JobDiscoveryService } from "../packages/discovery/src/job-discovery-service.js";
import {
  parseWantedlyCompanyPage,
  wantedlyRobotsAllowsCompanyProjects,
  type WantedlyCompanySeed,
} from "../packages/discovery/src/wantedly-company-discovery.js";
import { discoveryBackfillWindow, evaluateLeadForBackfill } from "../packages/freshness/src/discovery-backfill-window.js";
import { replaceWithAtomicFile } from "../packages/operations/src/atomic-file.js";

const databaseUrl = required("DATABASE_URL");
const seedFile = process.env.WANTEDLY_COMPANY_FILE ?? "config/wantedly-company-seeds.json";
const hostIntervalMs = Math.max(1_000, positiveInteger(process.env.WANTEDLY_HOST_INTERVAL_MS, 1_000));
const maximumBytes = 8 * 1024 * 1024;
const backfillWindow = discoveryBackfillWindow(process.env.DISCOVERY_BACKFILL_DAYS);
const { Pool } = pg;
const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl }) }) });
const discovery = new JobDiscoveryService(db);

try {
  const seeds = JSON.parse(await fs.readFile(path.resolve(seedFile), "utf8")) as WantedlyCompanySeed[];
  const discoverySourceId = await ensureDiscoverySource();
  const robots = await fetchBytes("https://www.wantedly.com/robots.txt", "text/plain");
  const rows: Array<Record<string, unknown>> = [];
  for (const seed of seeds) {
    const pageUrl = `https://www.wantedly.com/companies/${encodeURIComponent(seed.tenantKey)}/projects`;
    const pathName = new URL(pageUrl).pathname;
    if (!wantedlyRobotsAllowsCompanyProjects(robots, pathName)) {
      throw new Error(`Wantedly robots.txt does not allow ${pathName}; collection stopped before company requests`);
    }
    const observedAt = new Date().toISOString();
    try {
      const bytes = await fetchBytes(pageUrl, "text/html,application/xhtml+xml");
      const parsed = parseWantedlyCompanyPage(bytes, seed, discoverySourceId, pageUrl, observedAt);
      const importRunId = await discovery.recordFinalizedAuthoritativeImport({
        discoverySourceId,
        idempotencyKey: `wantedly:${seed.tenantKey}:${observedAt.slice(0, 10)}:${parsed.rawHash}`,
        pageCount: 1,
        providerTotal: parsed.normalProjectCount,
        discoveredCount: parsed.normalProjectCount,
        rawHash: parsed.rawHash,
        validation: { allPagesCompleted: true, tenantIdentityConsistent: true,
          providerTotalMatched: true, parseErrors: [] },
      });
      let eligible = 0;
      let inserted = 0;
      let excludedOutsideWindow = 0;
      let excludedUnknownPublication = 0;
      for (const lead of parsed.leads) {
        const windowDecision = evaluateLeadForBackfill(lead, backfillWindow);
        if (windowDecision !== null && !windowDecision.eligible) {
          if (windowDecision.reason === "publication_date_unknown") excludedUnknownPublication += 1;
          else excludedOutsideWindow += 1;
          continue;
        }
        eligible += 1;
        const result = await discovery.ingest({ ...lead, discoveryImportRunId: importRunId,
          observationKey: `${lead.observationKey}:snapshot:${importRunId}` });
        if (result.candidateCreated) inserted += 1;
      }
      rows.push({ tenantKey: seed.tenantKey, companyName: parsed.companyName, status: "authoritative",
        projects: parsed.projectCount, normalProjects: parsed.normalProjectCount, eligible, inserted,
        excludedOutsideWindow, excludedUnknownPublication });
    } catch (error) {
      rows.push({ tenantKey: seed.tenantKey, status: "failed",
        error: error instanceof Error ? error.message : String(error) });
    }
    await delay(hostIntervalMs);
  }
  const summary = await discovery.summary();
  const report = { generatedAt: new Date().toISOString(), robotsChecked: true,
    policy: "public metadata only; no login, member data, full descriptions, or AI training",
    publicationWindow: backfillWindow === null ? null : {
      days: backfillWindow.days, cutoffDate: backfillWindow.cutoffDate, today: backfillWindow.today,
    },
    rows,
    summary,
  };
  await fs.mkdir(path.resolve("tmp"), { recursive: true });
  await replaceWithAtomicFile(path.resolve("tmp/wantedly-discovery-report.json"), (temporaryPath) =>
    fs.writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }));
  process.stdout.write(`${JSON.stringify({ audited: rows.length, inserted: rows.reduce((sum, row) =>
    sum + (typeof row.inserted === "number" ? row.inserted : 0), 0), summary })}\n`);
} finally {
  await db.destroy();
}

async function ensureDiscoverySource(): Promise<string> {
  const result = await sql<{ id: string }>`INSERT INTO discovery_sources(source_key,name,source_kind,base_url,policy_notes)
    VALUES ('wantedly-public-company-projects','Wantedly public company project metadata','public_ats',
      'https://www.wantedly.com/companies/',
      'Discovery only. JETRO-linked company pages; robots.txt checked before every run; /companies/{tenant}/projects only; '
        || 'stable id, title, location, and exact published_at only; no login, member/candidate data, full job content, or AI training; '
        || '1 request/second host cap. Terms reviewed 2026-07-18.')
    ON CONFLICT(source_key) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,
      policy_notes=excluded.policy_notes,updated_at=now() RETURNING id`.execute(db);
  return result.rows[0]!.id;
}

async function fetchBytes(url: string, accept: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000), headers: {
    accept, "user-agent": "JapanJobAgent/0.2 (+private personal use)",
  } });
  if (!response.ok) throw new Error(`Wantedly returned ${response.status} for ${url}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maximumBytes) throw new Error(`Wantedly response exceeds ${maximumBytes} bytes`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) throw new Error(`Invalid Wantedly response size for ${url}`);
  return bytes;
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
