import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutboxDatabase } from "../../db/src/outbox.js";
import { migrate } from "../../db/src/migrate.js";
import { AiTaskService } from "./ai-task-service.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe.sequential;
const { Pool } = pg;

integration("AI task queue persistence", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool }) });
  const tasks = new AiTaskService(db);

  beforeAll(async () => migrate(databaseUrl));
  afterAll(async () => db.destroy());

  it("enqueues idempotently and lets concurrent workers lease a task only once", async () => {
    const uniqueContent = crypto.randomUUID();
    const input = {
      kind: "job_embedding" as const,
      payload: { canonicalJobVersionId: crypto.randomUUID(), contentHash: "a".repeat(64) },
      providerKey: "fixture-provider",
      modelKey: "fixture-embedding-v1",
      idempotencyParts: [uniqueContent, "fixture-embedding-v1", "job-embedding-v1"],
    };
    const first = await tasks.enqueue(input);
    const replay = await tasks.enqueue(input);
    expect(first).toMatchObject({ created: true });
    expect(replay).toEqual({ taskId: first.taskId, created: false });

    const [workerA, workerB] = await Promise.all([
      tasks.claim(`worker-a-${uniqueContent}`, 1),
      tasks.claim(`worker-b-${uniqueContent}`, 1),
    ]);
    const leased = [...workerA, ...workerB].filter((task) => task.id === first.taskId);
    expect(leased).toHaveLength(1);
    await tasks.complete(first.taskId, { dimensions: 3 }, { inputTokens: 7, outputTokens: 0 });

    const row = await sql<{ state: string; attempt_count: number; input_tokens: number }>`
      SELECT state,attempt_count,input_tokens FROM ai_tasks WHERE id=${first.taskId}::uuid`.execute(db);
    expect(row.rows[0]).toEqual({ state: "succeeded", attempt_count: 1, input_tokens: 7 });
  });
});
