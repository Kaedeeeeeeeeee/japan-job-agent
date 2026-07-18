import { promises as fs } from "node:fs";
import path from "node:path";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { OutboxDatabase } from "../packages/db/src/outbox.js";
import { SourceExpansionStore } from "../packages/source-expansion/src/source-expansion-store.js";
import type { ExpansionSourceKind } from "../packages/source-expansion/src/tenant-artifact.js";

interface RankedTenant {
  kind: ExpansionSourceKind;
  tenantKey: string;
  companyName?: string;
  officialReferrerUrl: string;
}

interface PromotionReport {
  reports: Array<{ kind: ExpansionSourceKind; tenantKey: string; status: string; activeJobs?: number }>;
}

const target = positiveInteger(valueAfter("--target"), 5_500, 100_000);
const maximumTenants = positiveInteger(valueAfter("--batch") ?? process.env.PROMOTION_MAX_TENANTS, 1_000, 5_000);
const { Pool } = pg;
const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: required("DATABASE_URL") }) }) });
const store = new SourceExpansionStore(db);
let runId: string | undefined;

try {
  runId = await store.beginRun("promote", { requestedBatch: maximumTenants });
  const rows = (await sql<{ source_kind: ExpansionSourceKind; tenant_key: string; company_name: string | null;
    official_referrer_url: string }>`SELECT source_kind,tenant_key,company_name,official_referrer_url
    FROM source_tenant_candidates WHERE review_state IN ('scanned','verification_pending')
      AND japan_recent_job_count>0 AND official_referrer_url IS NOT NULL
    ORDER BY japan_signal DESC,japan_recent_job_count DESC,latest_published_on DESC NULLS LAST,
      last_scanned_at,id LIMIT ${maximumTenants}`.execute(db)).rows;
  const seeds: RankedTenant[] = rows.map((row) => ({ kind: row.source_kind, tenantKey: row.tenant_key,
    ...(row.company_name === null ? {} : { companyName: row.company_name }), officialReferrerUrl: row.official_referrer_url }));
  const filename = path.resolve("tmp/ranked-source-tenant-seeds.json");
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, `${JSON.stringify(seeds, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  process.env.PUBLIC_ATS_TENANT_FILE = filename;
  process.env.PROMOTION_ACTIVE_TARGET = String(target);
  process.env.PROMOTION_MAX_TENANTS = String(maximumTenants);
  await import("./promote-public-ats-discovery.js");
  const promotion = JSON.parse(await fs.readFile(path.resolve("tmp/public-ats-promotion-report.json"), "utf8")) as PromotionReport;
  let verified = 0;
  let discoveryOnly = 0;
  let retryable = 0;
  for (const report of promotion.reports) {
    if (report.status === "formalized") {
      const updated = await sql<{ id: string }>`UPDATE source_tenant_candidates candidate SET review_state='verified',
          verified_at=COALESCE(verified_at,now()),linked_source_instance_id=source.id,failure_reason=NULL,updated_at=now()
        FROM source_instances source WHERE candidate.source_kind=${report.kind}::source_kind
          AND candidate.tenant_key=${report.tenantKey} AND source.source_kind=candidate.source_kind
          AND source.tenant_key=candidate.tenant_key AND source.verification_state='verified' RETURNING candidate.id`.execute(db);
      verified += updated.rows.length;
    } else if (["ats_backlink_not_found", "corporate_url_is_recruitment_platform", "corporate_url_not_https",
      "invalid_corporate_url"].includes(report.status)) {
      await updateQueueState(report.kind, report.tenantKey, "discovery_only", report.status);
      discoveryOnly += 1;
    } else if (report.status !== "no_japan_candidates") {
      await updateQueueState(report.kind, report.tenantKey, "retryable_failure", report.status);
      retryable += 1;
    }
  }
  const metrics = await store.metrics();
  const counters = { target, ranked: seeds.length, audited: promotion.reports.length, verified, discoveryOnly, retryable,
    activeTrustedJobs: metrics.activeTrustedJobs };
  await store.finishRun(runId, "succeeded", counters);
  process.stdout.write(`${JSON.stringify({ runId, ...counters }, null, 2)}\n`);
} catch (error) {
  if (runId !== undefined) await store.finishRun(runId, "failed", {}, [error instanceof Error ? error.message : String(error)]);
  throw error;
} finally {
  await db.destroy();
}

async function updateQueueState(kind: ExpansionSourceKind, tenantKey: string,
  state: "discovery_only" | "retryable_failure", reason: string): Promise<void> {
  await sql`UPDATE source_tenant_candidates SET review_state=${state},failure_reason=${reason},
    next_scan_at=CASE WHEN ${state}='retryable_failure' THEN now()+interval '24 hours' ELSE next_scan_at END,
    updated_at=now() WHERE source_kind=${kind}::source_kind AND tenant_key=${tenantKey}`.execute(db);
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
