import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { FinalizedSnapshot } from "../../contracts/src/index.js";
import type { OutboxDatabase } from "../../db/src/outbox.js";

interface LifecycleRow {
  id: string;
  stable_key: string;
  lifecycle_state: "active" | "suspect" | "closed";
  missing_count: number;
  last_authoritative_missing_at: Date | null;
}

interface PolicyRow {
  required_missing_count: number;
  minimum_interval_seconds: string;
}

export class LifecycleService {
  constructor(private readonly db: Kysely<OutboxDatabase>) {}

  async reconcileSnapshot(
    sourceInstanceId: string,
    syncRunId: string,
    snapshot: FinalizedSnapshot,
    observedAt: Date,
  ): Promise<void> {
    if (snapshot.kind !== "authoritative") return;
    const present = new Set(snapshot.jobs.map((job) => job.identity.stableKey));
    await this.db.transaction().execute(async (trx) => {
      const policyResult = await sql<PolicyRow>`SELECT required_missing_count,
        extract(epoch FROM minimum_missing_interval)::text AS minimum_interval_seconds
        FROM source_policies WHERE source_instance_id = ${sourceInstanceId}::uuid`.execute(trx);
      const policy = policyResult.rows[0];
      if (policy === undefined) throw new Error(`Source ${sourceInstanceId} has no lifecycle policy`);
      const records = await sql<LifecycleRow>`SELECT id, stable_key, lifecycle_state, missing_count, last_authoritative_missing_at
        FROM source_job_records WHERE source_instance_id = ${sourceInstanceId}::uuid FOR UPDATE`.execute(trx);
      for (const record of records.rows) {
        if (present.has(record.stable_key)) {
          if (record.lifecycle_state !== "active") {
            await transition(trx, record.id, record.lifecycle_state, "active", syncRunId, "observed_in_authoritative_snapshot", observedAt);
          }
          await sql`UPDATE source_job_records SET lifecycle_state = 'active', missing_count = 0,
            last_authoritative_missing_at = NULL, closed_at = NULL, last_seen_at = ${observedAt}
            WHERE id = ${record.id}::uuid`.execute(trx);
          continue;
        }
        const intervalMs = Number(policy.minimum_interval_seconds) * 1_000;
        if (record.last_authoritative_missing_at !== null
          && observedAt.getTime() - record.last_authoritative_missing_at.getTime() < intervalMs) continue;
        const missingCount = record.missing_count + 1;
        const nextState = missingCount >= policy.required_missing_count ? "closed" : "suspect";
        if (nextState !== record.lifecycle_state) {
          await transition(trx, record.id, record.lifecycle_state, nextState, syncRunId, "missing_from_authoritative_snapshot", observedAt);
        }
        await sql`UPDATE source_job_records SET lifecycle_state = ${nextState}::job_lifecycle_state,
          missing_count = ${missingCount}, last_authoritative_missing_at = ${observedAt},
          closed_at = ${nextState === "closed" ? observedAt : null} WHERE id = ${record.id}::uuid`.execute(trx);
      }
    });
  }

  async closeSingleRecord(
    sourceJobRecordId: string,
    reason: "http_410" | "explicit_closed_text" | "manual_confirmation",
    observedAt: Date,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const current = await sql<{ lifecycle_state: LifecycleRow["lifecycle_state"] }>`SELECT lifecycle_state
        FROM source_job_records WHERE id = ${sourceJobRecordId}::uuid FOR UPDATE`.execute(trx);
      const state = current.rows[0]?.lifecycle_state;
      if (state === undefined) throw new Error(`Source job ${sourceJobRecordId} does not exist`);
      if (state !== "closed") await transition(trx, sourceJobRecordId, state, "closed", null, reason, observedAt);
      await sql`UPDATE source_job_records SET lifecycle_state = 'closed', closed_at = ${observedAt}
        WHERE id = ${sourceJobRecordId}::uuid`.execute(trx);
    });
  }
}

async function transition(
  trx: Transaction<OutboxDatabase>,
  recordId: string,
  from: LifecycleRow["lifecycle_state"],
  to: LifecycleRow["lifecycle_state"],
  syncRunId: string | null,
  reason: string,
  occurredAt: Date,
): Promise<void> {
  await sql`INSERT INTO job_state_transitions(id, source_job_record_id, from_state, to_state, source_sync_run_id, reason, occurred_at)
    VALUES (${randomUUID()}::uuid, ${recordId}::uuid, ${from}::job_lifecycle_state, ${to}::job_lifecycle_state,
    ${syncRunId}::uuid, ${reason}, ${occurredAt})`.execute(trx);
}

