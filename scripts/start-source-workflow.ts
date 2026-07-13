import { randomUUID } from "node:crypto";
import { Connection, Client } from "@temporalio/client";
import pg from "pg";
import { sourceSyncWorkflow } from "../packages/workflows/src/source-sync-workflow.js";

const tenantKey = process.argv[2];
if (tenantKey === undefined) throw new Error("Usage: pnpm temporal:refresh-source <tenant-key>");
const { Client: PgClient } = pg;
const database = new PgClient({ connectionString: required("DATABASE_URL") });
await database.connect();
const source = await database.query<{ id: string }>(`SELECT id FROM source_instances
  WHERE tenant_key=$1 AND verification_state='verified'`, [tenantKey]);
await database.end();
const sourceId = source.rows[0]?.id;
if (sourceId === undefined) throw new Error(`Verified source ${tenantKey} does not exist`);
const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233" });
try {
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default" });
  const handle = await client.workflow.start(sourceSyncWorkflow, {
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "japan-job-agent",
    workflowId: `source-refresh-${sourceId}-${randomUUID()}`,
    args: [{ sourceInstanceId: sourceId }],
  });
  const result = await handle.result();
  process.stdout.write(`${JSON.stringify({ workflowId: handle.workflowId, result })}\n`);
} finally {
  await connection.close();
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}
