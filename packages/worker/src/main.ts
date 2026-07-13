import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.js";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "japan-job-agent";
const connection = await NativeConnection.connect({ address });
const worker = await Worker.create({
  connection,
  namespace,
  taskQueue,
  workflowsPath: new URL("../../workflows/src/source-sync-workflow.ts", import.meta.url).pathname,
  activities,
  maxConcurrentActivityTaskExecutions: Number(process.env.WORKER_ACTIVITY_CONCURRENCY ?? 2),
});
await worker.run();
