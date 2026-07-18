import { createHash, randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { OutboxDatabase } from "../packages/db/src/outbox.js";
import { JobDiscoveryService } from "../packages/discovery/src/job-discovery-service.js";
import { SourceExpansionStore, type ClaimedTenant } from "../packages/source-expansion/src/source-expansion-store.js";
import { scanTenant, type TenantScanResult } from "../packages/source-expansion/src/tenant-scanner.js";
import type { ExpansionSourceKind } from "../packages/source-expansion/src/tenant-artifact.js";

const requestedBackfill = valueAfter("--backfill-days") ?? "30";
if (requestedBackfill !== "30" && requestedBackfill !== "183" && requestedBackfill !== "auto") {
  throw new Error("--backfill-days must be 30, 183, or auto");
}
const batch = positiveInteger(valueAfter("--batch"), 400, 400);
const workers = positiveInteger(process.env.SOURCE_EXPANSION_WORKERS, 4, 4);
const hostIntervalMs = Math.max(1_000, positiveInteger(process.env.SOURCE_EXPANSION_HOST_INTERVAL_MS, 1_000, 60_000));
const tenantTimeoutMs = positiveInteger(process.env.SOURCE_EXPANSION_TENANT_TIMEOUT_MS, 120_000, 900_000);
const runDeadline = Date.now() + positiveInteger(process.env.SOURCE_EXPANSION_RUN_TIMEOUT_MS, 4 * 60 * 60_000, 4 * 60 * 60_000);
const { Pool } = pg;
const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: required("DATABASE_URL") }) }) });
const store = new SourceExpansionStore(db);
const discovery = new JobDiscoveryService(db);
const workerId = `source-expansion:${process.pid}:${randomUUID()}`;
const rateLimited = rateLimitedFetch(hostIntervalMs);
let runId: string | undefined;

try {
  const backfillDays = requestedBackfill === "auto" ? await store.recommendedBackfillDays() : Number(requestedBackfill) as 30 | 183;
  runId = await store.beginRun("scan", { backfillDays, requestedBatch: batch });
  const sources = await ensureDiscoverySources();
  const claimed = await store.claimTenants(workerId, batch, Math.max(tenantTimeoutMs + 60_000,
    runDeadline - Date.now() + 5 * 60_000), backfillDays);
  const counters = {
    claimed: claimed.length, scanned: 0, authoritative: 0, partial: 0, empty: 0, failed: 0,
    jobsSeen: 0, eligibleJapanJobs: 0, candidatesCreated: 0, excludedNonJapan: 0,
    excludedUnknownLocation: 0, excludedUnknownPublication: 0, excludedOutsideWindow: 0,
    candidateGrowthRatio: 0,
  };
  const errors: Array<{ sourceKind: string; tenantKey: string; error: string }> = [];
  await mapWithConcurrency(claimed, workers, async (tenant) => {
    if (Date.now() >= runDeadline) {
      await store.releaseLease(tenant.id, workerId, "source_expansion_run_timeout");
      counters.failed += 1;
      return;
    }
    try {
      const result = await scanWithRetry(tenant, sources[tenant.sourceKind], backfillDays, rateLimited, tenantTimeoutMs);
      counters.scanned += 1;
      counters.jobsSeen += result.snapshot.jobs.length;
      counters.eligibleJapanJobs += result.leads.length;
      counters.excludedNonJapan += result.excludedNonJapan;
      counters.excludedUnknownLocation += result.excludedUnknownLocation;
      counters.excludedUnknownPublication += result.excludedUnknownPublication;
      counters.excludedOutsideWindow += result.excludedOutsideWindow;
      const complete = result.snapshot.kind === "authoritative" && result.snapshot.jobs.length > 0;
      if (result.snapshot.kind === "authoritative") counters.authoritative += 1; else counters.partial += 1;
      if (result.snapshot.jobs.length === 0) counters.empty += 1;
      if (complete) {
        const fingerprint = snapshotFingerprint(result);
        const importRunId = await discovery.recordFinalizedAuthoritativeImport({
          discoverySourceId: sources[tenant.sourceKind],
          idempotencyKey: `source-expansion:${tenant.sourceKind}:${tenant.tenantKey}:${new Date().toISOString().slice(0, 10)}:${fingerprint}`,
          pageCount: result.snapshot.pageCount,
          providerTotal: result.snapshot.providerTotal ?? null,
          discoveredCount: result.snapshot.jobs.length,
          rawHash: fingerprint,
          validation: {
            allPagesCompleted: result.snapshot.validation.allPagesCompleted,
            tenantIdentityConsistent: result.snapshot.validation.tenantIdentityConsistent,
            providerTotalMatched: result.snapshot.validation.providerTotalMatched,
            parseErrors: [...result.snapshot.validation.parseErrors],
          },
        });
        for (const lead of result.leads) {
          const persisted = await discovery.ingest({ ...lead, discoveryImportRunId: importRunId,
            observationKey: `${lead.observationKey}:snapshot:${importRunId}` });
          if (persisted.candidateCreated) counters.candidatesCreated += 1;
        }
      }
      await store.completeScan({ id: tenant.id, workerId, backfillDays,
        snapshotKind: result.snapshot.kind === "authoritative" ? "authoritative" : "partial",
        completed: complete, japanRecentJobs: result.leads.length, latestPublishedOn: result.latestPublishedOn,
        ...(result.explicitCompanyUrl === null ? {} : { explicitCompanyUrl: result.explicitCompanyUrl }),
        ...(!complete ? { error: result.snapshot.kind === "partial"
          ? result.snapshot.validation.parseErrors.join("; ").slice(0, 1_000) || "partial_snapshot"
          : "empty_snapshot" } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      counters.failed += 1;
      errors.push({ sourceKind: tenant.sourceKind, tenantKey: tenant.tenantKey, error: message.slice(0, 1_000) });
      await store.releaseLease(tenant.id, workerId, message);
    }
  });
  const baselineValid = (await sql<{ value: number }>`SELECT COALESCE((baseline_metrics->>'validJobs')::int,0) value
    FROM source_expansion_runs WHERE id=${runId}::uuid`.execute(db)).rows[0]?.value ?? 0;
  counters.candidateGrowthRatio = baselineValid === 0 ? 0 : counters.candidatesCreated / baselineValid;
  await store.finishRun(runId, "succeeded", counters, errors);
  process.stdout.write(`${JSON.stringify({ runId, backfillDays, batch, workers, counters, errors }, null, 2)}\n`);
} catch (error) {
  if (runId !== undefined) await store.finishRun(runId, "failed", {}, [error instanceof Error ? error.message : String(error)]);
  throw error;
} finally {
  await db.destroy();
}

async function ensureDiscoverySources(): Promise<Record<ExpansionSourceKind, string>> {
  const kinds: ExpansionSourceKind[] = ["greenhouse", "workday", "smartrecruiters", "lever", "ashby", "hrmos", "herp", "talentio"];
  const output = {} as Record<ExpansionSourceKind, string>;
  for (const kind of kinds) {
    const result = await sql<{ id: string }>`INSERT INTO discovery_sources(source_key,name,source_kind,base_url,policy_notes)
      VALUES (${`source-expansion-${kind}`},${`${kind} tenant expansion`},
        ${["hrmos", "herp", "talentio"].includes(kind) ? "official_career_site" : "public_ats"}::discovery_source_kind,
        ${sourceBase(kind)},'Discovery only; public listings; no login or personal candidate data; strict promotion is separate.')
      ON CONFLICT(source_key) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,
        policy_notes=excluded.policy_notes,updated_at=now() RETURNING id`.execute(db);
    output[kind] = result.rows[0]!.id;
  }
  return output;
}

async function scanWithRetry(tenant: ClaimedTenant, discoverySourceId: string, backfillDays: number,
  fetchImplementation: typeof fetch, timeoutMs: number): Promise<TenantScanResult> {
  let last: TenantScanResult | undefined;
  let lastError: unknown;
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const result = await scanTenant({ tenant, discoverySourceId, backfillDays, fetchImplementation,
        signal: AbortSignal.timeout(remaining) });
      last = result;
      if (result.snapshot.kind === "authoritative") return result;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) {
      const backoff = Math.min(deadline - Date.now(), 2 ** attempt * 2_000 + Math.floor(Math.random() * 500));
      if (backoff > 0) await delay(backoff);
    }
  }
  if (last === undefined) {
    throw lastError instanceof Error ? lastError : new Error("Tenant scan exhausted its configured retry budget");
  }
  return last;
}

function snapshotFingerprint(result: TenantScanResult): string {
  return createHash("sha256").update(result.snapshot.jobs.map((job) =>
    `${job.identity.stableKey}:${createHash("sha256").update(job.raw).digest("hex")}`).sort().join("\n")).digest("hex");
}

function sourceBase(kind: ExpansionSourceKind): string {
  if (kind === "greenhouse") return "https://boards-api.greenhouse.io/v1/boards/";
  if (kind === "workday") return "https://www.myworkdayjobs.com/";
  if (kind === "smartrecruiters") return "https://api.smartrecruiters.com/v1/companies/";
  if (kind === "lever") return "https://api.lever.co/v0/postings/";
  if (kind === "ashby") return "https://api.ashbyhq.com/posting-api/job-board/";
  if (kind === "hrmos") return "https://hrmos.co/pages/";
  if (kind === "herp") return "https://herp.careers/v1/";
  return "https://open.talentio.com/r/1/c/";
}

function rateLimitedFetch(intervalMs: number): typeof fetch {
  const nextByHost = new Map<string, number>();
  const queues = new Map<string, Promise<void>>();
  return async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const previous = queues.get(url.hostname) ?? Promise.resolve();
    const ready = previous.then(async () => {
      const wait = Math.max(0, (nextByHost.get(url.hostname) ?? 0) - Date.now());
      if (wait > 0) await delay(wait);
      nextByHost.set(url.hostname, Date.now() + intervalMs);
    });
    queues.set(url.hostname, ready.catch(() => undefined));
    await ready;
    return fetch(input, init);
  };
}

async function mapWithConcurrency<T>(values: T[], concurrency: number, worker: (value: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next; next += 1;
      await worker(values[index]!);
    }
  }));
}

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) throw new Error(`Expected integer 1-${maximum}, received ${value}`);
  return parsed;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
