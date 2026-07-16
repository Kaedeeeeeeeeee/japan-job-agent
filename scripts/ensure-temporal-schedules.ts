import { Connection, Client } from "@temporalio/client";
import pg from "pg";

const databaseUrl = required("DATABASE_URL");
const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "japan-job-agent";
const { Client: PgClient } = pg;
const database = new PgClient({ connectionString: databaseUrl });
await database.connect();
const rows = await database.query<{ id: string; tenant_key: string; interval_hours: number }>(`SELECT s.id,s.tenant_key,ss.interval_hours
  FROM source_instances s JOIN source_schedules ss ON ss.source_instance_id=s.id
  WHERE s.verification_state='verified' AND s.source_kind<>'manual' ORDER BY s.tenant_key`);
const connection = await Connection.connect({ address });
const temporal = new Client({ connection, namespace });
try {
  for (const row of rows.rows) {
    const scheduleId = `source-${row.id}`;
    try {
      await temporal.schedule.create({
        scheduleId,
        spec: { intervals: [{ every: `${row.interval_hours}h` }] },
        action: { type: "startWorkflow", workflowType: "sourceSyncWorkflow", taskQueue,
          args: [{ sourceInstanceId: row.id }], workflowId: `${scheduleId}-scheduled` },
      });
      process.stdout.write(`created ${row.tenant_key}: ${row.interval_hours}h\n`);
    } catch (error) {
      if (!(error instanceof Error) || !/already exists/i.test(error.message)) throw error;
      const handle = temporal.schedule.getHandle(scheduleId);
      await handle.update((current) => ({ ...current, spec: { intervals: [{ every: `${row.interval_hours}h` }] } }));
      process.stdout.write(`updated ${row.tenant_key}: ${row.interval_hours}h\n`);
    }
  }
  if (["AI_ENRICHMENT_ENABLED", "SEMANTIC_RETRIEVAL_ENABLED", "AI_EXPLANATIONS_ENABLED"]
    .some((name) => process.env[name] === "true")) {
    const scheduleId = "ai-task-sweep";
    try {
      await temporal.schedule.create({
        scheduleId,
        spec: { intervals: [{ every: "1m" }] },
        action: { type: "startWorkflow", workflowType: "aiTaskSweepWorkflow", taskQueue,
          args: [], workflowId: `${scheduleId}-scheduled` },
      });
      process.stdout.write("created ai-task-sweep: 1m\n");
    } catch (error) {
      if (!(error instanceof Error) || !/already exists/i.test(error.message)) throw error;
      const handle = temporal.schedule.getHandle(scheduleId);
      await handle.update((current) => ({ ...current, spec: { intervals: [{ every: "1m" }] } }));
      process.stdout.write("updated ai-task-sweep: 1m\n");
    }
  }
} finally {
  await database.end();
  await connection.close();
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}
