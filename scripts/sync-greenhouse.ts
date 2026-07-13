import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { GreenhouseConnector } from "../packages/connectors-greenhouse/src/greenhouse-connector.js";
import type { SourceInstanceRef } from "../packages/contracts/src/index.js";
import type { OutboxDatabase } from "../packages/db/src/outbox.js";
import { SourceSyncService } from "../packages/ingestion/src/source-sync-service.js";
import { createObjectStore } from "./object-store-config.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
const requestedTenants = new Set(process.argv.slice(2));
const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl });
const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool }) });
try {
  const sources = await sql<{ id: string; tenant_key: string; base_url: string }>`SELECT id, tenant_key, base_url
    FROM source_instances WHERE source_kind = 'greenhouse' AND verification_state = 'verified'
    ORDER BY tenant_key`.execute(db);
  const selected = sources.rows.filter((row) => requestedTenants.size === 0 || requestedTenants.has(row.tenant_key));
  if (selected.length === 0) throw new Error("No verified Greenhouse sources matched");
  const connector = new GreenhouseConnector();
  const store = createObjectStore();
  for (const row of selected) {
    const source: SourceInstanceRef = {
      id: row.id,
      sourceKind: "greenhouse",
      tenantKey: row.tenant_key,
      baseUrl: row.base_url,
    };
    const service = new SourceSyncService(db, connector, store);
    const invocationKey = process.env.SYNC_INVOCATION_KEY ?? new Date().toISOString().slice(0, 16);
    const result = await service.run({
      source,
      idempotencyKey: `manual:${invocationKey}`,
      temporalWorkflowId: `manual-greenhouse-${row.tenant_key}`,
      temporalRunId: new Date().toISOString(),
    });
    process.stdout.write(`${JSON.stringify({
      tenant: row.tenant_key,
      syncRunId: result.syncRunId,
      kind: result.snapshot?.kind ?? "reused",
      jobs: result.snapshot?.jobs.length ?? 0,
      newRecords: result.persistedRecords,
      newVersions: result.persistedVersions,
    })}\n`);
  }
} finally {
  await db.destroy();
}
