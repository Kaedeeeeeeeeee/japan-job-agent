import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { EnrichableJobField } from "../../contracts/src/index.js";
import type { OutboxDatabase } from "../../db/src/outbox.js";
import type { ParsedJob } from "../../parser/src/deterministic-job-parser.js";
import type { SafeProfile } from "../../profile/src/build-profile.js";

export type AiTaskKind = "field_enrichment" | "section_embedding" | "job_embedding" | "profile_embedding" | "recommendation_explanation";
export type AiTaskState = "pending" | "leased" | "retryable_failed" | "succeeded" | "terminal_failed" | "cancelled";

export interface AiTaskRow {
  id: string;
  task_kind: AiTaskKind;
  state: AiTaskState;
  idempotency_key: string;
  payload: Record<string, unknown>;
  provider_key: string;
  model_key: string;
  prompt_version: string | null;
  available_at: Date;
  lease_owner: string | null;
  leased_at: Date | null;
  lease_expires_at: Date | null;
  attempt_count: number;
  max_attempts: number;
  input_tokens: number;
  output_tokens: number;
  last_error_code: string | null;
  last_error: string | null;
  result: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface EnqueueAiTaskInput {
  kind: AiTaskKind;
  payload: Record<string, unknown>;
  providerKey: string;
  modelKey: string;
  promptVersion?: string;
  idempotencyParts: readonly unknown[];
  maxAttempts?: number;
}

export class AiTaskService {
  constructor(private readonly db: Kysely<OutboxDatabase>) {}

  async enqueue(input: EnqueueAiTaskInput): Promise<{ taskId: string; created: boolean }> {
    const idempotencyKey = aiTaskIdempotencyKey(input.kind, input.idempotencyParts);
    const taskId = randomUUID();
    const inserted = await sql<{ id: string }>`INSERT INTO ai_tasks(
        id,task_kind,idempotency_key,payload,provider_key,model_key,prompt_version,max_attempts
      ) VALUES (
        ${taskId}::uuid,${input.kind}::ai_task_kind,${idempotencyKey},${JSON.stringify(input.payload)}::jsonb,
        ${input.providerKey},${input.modelKey},${input.promptVersion ?? null},${input.maxAttempts ?? 5}
      ) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`.execute(this.db);
    if (inserted.rows[0] !== undefined) return { taskId, created: true };
    const existing = await sql<{ id: string }>`SELECT id FROM ai_tasks WHERE idempotency_key=${idempotencyKey}`.execute(this.db);
    const id = existing.rows[0]?.id;
    if (id === undefined) throw new Error("Idempotent AI task disappeared");
    return { taskId: id, created: false };
  }

  async claim(workerId: string, limit: number, leaseSeconds = 120): Promise<AiTaskRow[]> {
    const result = await sql<AiTaskRow>`WITH candidates AS (
        SELECT id FROM ai_tasks
        WHERE available_at<=now()
          AND (state IN ('pending','retryable_failed') OR (state='leased' AND lease_expires_at<now()))
        ORDER BY available_at,created_at,id
        LIMIT ${Math.max(1, limit)} FOR UPDATE SKIP LOCKED
      )
      UPDATE ai_tasks task SET
        state='leased',lease_owner=${workerId},leased_at=now(),
        lease_expires_at=now()+make_interval(secs=>${Math.max(30, leaseSeconds)}),
        attempt_count=task.attempt_count+1,updated_at=now(),completed_at=NULL
      FROM candidates WHERE task.id=candidates.id RETURNING task.*`.execute(this.db);
    return result.rows;
  }

  async complete(taskId: string, result: Record<string, unknown>, usage: { inputTokens: number; outputTokens: number }): Promise<void> {
    await sql`UPDATE ai_tasks SET state='succeeded',result=${JSON.stringify(result)}::jsonb,
      input_tokens=${usage.inputTokens},output_tokens=${usage.outputTokens},last_error_code=NULL,last_error=NULL,
      lease_owner=NULL,leased_at=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now()
      WHERE id=${taskId}::uuid AND state='leased'`.execute(this.db);
  }

  async fail(task: AiTaskRow, error: unknown): Promise<"retryable_failed" | "terminal_failed"> {
    const retryable = isRetryableAiError(error) && task.attempt_count < task.max_attempts;
    const state = retryable ? "retryable_failed" : "terminal_failed";
    const delaySeconds = Math.min(3_600, 15 * 2 ** Math.max(0, task.attempt_count - 1));
    await sql`UPDATE ai_tasks SET state=${state}::ai_task_state,
      available_at=CASE WHEN ${retryable} THEN now()+make_interval(secs=>${delaySeconds}) ELSE available_at END,
      lease_owner=NULL,leased_at=NULL,lease_expires_at=NULL,last_error_code=${aiErrorCode(error)},
      last_error=${error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000)},
      completed_at=CASE WHEN ${retryable} THEN NULL ELSE now() END,updated_at=now()
      WHERE id=${task.id}::uuid AND state='leased'`.execute(this.db);
    return state;
  }

  async tokensUsedToday(providerKey: string): Promise<number> {
    const result = await sql<{ tokens: number }>`SELECT coalesce(sum(input_tokens+output_tokens),0)::int tokens
      FROM ai_tasks WHERE provider_key=${providerKey} AND state='succeeded'
        AND completed_at>=date_trunc('day',now())`.execute(this.db);
    return result.rows[0]?.tokens ?? 0;
  }
}

export function enrichableUnknownFields(job: ParsedJob): EnrichableJobField[] {
  const fields: Array<[EnrichableJobField, { state: string }]> = [
    ["employmentTypes", job.employmentTypes],
    ["locations", job.locations],
    ["compensation", job.compensation],
    ["skills", job.skills],
    ["languages", job.languages],
    ["experienceRequirements", job.experienceRequirements],
  ];
  return fields.filter(([, fact]) => fact.state === "unknown").map(([field]) => field);
}

export function aiTaskIdempotencyKey(kind: AiTaskKind, parts: readonly unknown[]): string {
  return createHash("sha256").update(stableJson({ kind, parts })).digest("hex");
}

export function safeProfileEmbeddingText(profile: SafeProfile): string {
  return stableJson({
    schemaVersion: profile.schemaVersion,
    targetChannels: profile.targetChannels,
    rolePriorities: profile.rolePriorities,
    locations: profile.locations,
    employment: profile.employment,
    languages: profile.languages,
    visa: profile.visa,
    compensation: profile.compensation,
    normalizedSkills: profile.normalizedSkills,
    experienceSignals: profile.experienceSignals,
  });
}

export function canonicalJobEmbeddingText(title: string, structured: Record<string, unknown>): string {
  const description = typeof structured.descriptionText === "string" ? structured.descriptionText.slice(0, 8_000) : "";
  return stableJson({
    title,
    description,
    employmentTypes: structured.employmentTypes,
    locations: structured.locations,
    skills: structured.skills,
    languages: structured.languages,
    compensation: structured.compensation,
    experienceRequirements: structured.experienceRequirements,
  });
}

export function isRetryableAiError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) return false;
  if (error instanceof Error && /schema|outside the current|quote/i.test(error.message)) return false;
  return true;
}

function aiErrorCode(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return `http_${status}`;
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && /invalid JSON/i.test(error.message)) return "invalid_json";
  return "provider_error";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
