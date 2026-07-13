import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { ConnectorError, type FinalizedSnapshot, type SourceConnector, type SourceInstanceRef, type SourceJobIdentity } from "../../contracts/src/index.js";
import { calculateContentHashes } from "../../contracts/src/hashing.js";
import type { OutboxDatabase } from "../../db/src/outbox.js";
import { collectSnapshot, finalizeSingleRecord, type SnapshotCircuitPolicy } from "../../domain/src/snapshot-orchestrator.js";
import { LifecycleService } from "../../lifecycle/src/lifecycle-service.js";
import { normalizeApplicationUrl } from "../../canonical/src/normalize-application-url.js";
import type { RawObjectStore } from "../../storage/src/object-store.js";

export interface SourceSyncRequest {
  source: SourceInstanceRef;
  idempotencyKey: string;
  temporalWorkflowId?: string;
  temporalRunId?: string;
  recordIdentity?: SourceJobIdentity;
}

export interface SourceSyncResult {
  syncRunId: string;
  snapshot: FinalizedSnapshot | null;
  reused: boolean;
  persistedRecords: number;
  persistedVersions: number;
}

interface ExistingRun {
  id: string;
  status: "running" | "succeeded" | "failed";
  snapshot_kind: FinalizedSnapshot["kind"] | null;
}

interface SourcePolicyRow {
  allows_authoritative_snapshot: boolean;
  closure_circuit_min_previous_active: number;
  closure_circuit_max_missing_ratio: string;
  closure_circuit_max_missing_absolute: number;
}

export class SourceSyncService {
  constructor(
    private readonly db: Kysely<OutboxDatabase>,
    private readonly connector: SourceConnector,
    private readonly objectStore: RawObjectStore,
  ) {}

  async run(request: SourceSyncRequest, signal = AbortSignal.timeout(120_000)): Promise<SourceSyncResult> {
    const syncRunId = randomUUID();
    const created = await sql<{ id: string }>`
      INSERT INTO source_sync_runs(
        id, source_instance_id, idempotency_key, temporal_workflow_id, temporal_run_id
      ) VALUES (
        ${syncRunId}::uuid, ${request.source.id}::uuid, ${request.idempotencyKey},
        ${request.temporalWorkflowId ?? null}, ${request.temporalRunId ?? null}
      )
      ON CONFLICT (source_instance_id, idempotency_key) DO NOTHING
      RETURNING id`.execute(this.db);

    if (created.rows.length === 0) {
      const existing = await sql<ExistingRun>`SELECT id, status, snapshot_kind FROM source_sync_runs
        WHERE source_instance_id = ${request.source.id}::uuid AND idempotency_key = ${request.idempotencyKey}`.execute(this.db);
      const run = existing.rows[0];
      if (run === undefined) throw new Error("idempotent sync run disappeared");
      return { syncRunId: run.id, snapshot: null, reused: true, persistedRecords: 0, persistedVersions: 0 };
    }

    const [policy, previous] = await Promise.all([
      this.loadPolicy(request.source.id),
      sql<{ stable_key: string }>`SELECT stable_key FROM source_job_records
        WHERE source_instance_id = ${request.source.id}::uuid AND lifecycle_state = 'active'`.execute(this.db),
    ]);
    let singleExact: Awaited<ReturnType<SourceConnector["fetchRecord"]>> | undefined;
    let snapshot: FinalizedSnapshot;
    if (request.recordIdentity !== undefined) {
      try {
        singleExact = await this.connector.fetchRecord(request.recordIdentity, signal);
        snapshot = finalizeSingleRecord(request.source, singleExact, new Date());
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "record_closed") {
          const existing = await sql<{ id: string }>`SELECT id FROM source_job_records WHERE source_instance_id = ${request.source.id}::uuid
            AND (stable_key = ${request.recordIdentity.stableKey} OR canonical_url = ${request.recordIdentity.canonicalUrl}) LIMIT 1`.execute(this.db);
          const recordId = existing.rows[0]?.id;
          if (recordId !== undefined) await new LifecycleService(this.db).closeSingleRecord(recordId, "http_410", new Date());
          snapshot = emptySingleRecordSnapshot(request.source, error.message);
          await this.finalizeRun(syncRunId, request.source.id, snapshot, 0);
          return { syncRunId, snapshot, reused: false, persistedRecords: 0, persistedVersions: 0 };
        }
        await this.failRun(syncRunId, request.source.id, error);
        throw error;
      }
    } else {
      snapshot = await collectSnapshot(this.connector, {
        source: request.source,
        previousActiveStableKeys: new Set(previous.rows.map((row) => row.stable_key)),
        policy,
        now: () => new Date(),
        signal,
      });
    }

    let persistedRecords = 0;
    let persistedVersions = 0;
    try {
      for (const discovered of snapshot.jobs) {
        const exact = singleExact ?? await this.connector.fetchRecord(discovered.identity, signal);
        const result = await this.persistRecord(syncRunId, exact);
        persistedRecords += result.recordCreated ? 1 : 0;
        persistedVersions += result.versionCreated ? 1 : 0;
      }
    } catch (error) {
      snapshot = downgradeSnapshot(snapshot, error);
    }

    await new LifecycleService(this.db).reconcileSnapshot(request.source.id, syncRunId, snapshot, new Date());
    await this.finalizeRun(syncRunId, request.source.id, snapshot, persistedRecords);
    return { syncRunId, snapshot, reused: false, persistedRecords, persistedVersions };
  }

  private async loadPolicy(sourceInstanceId: string): Promise<SnapshotCircuitPolicy> {
    const result = await sql<SourcePolicyRow>`SELECT allows_authoritative_snapshot,
      closure_circuit_min_previous_active, closure_circuit_max_missing_ratio,
      closure_circuit_max_missing_absolute FROM source_policies
      WHERE source_instance_id = ${sourceInstanceId}::uuid`.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`Source ${sourceInstanceId} has no policy`);
    return {
      allowsAuthoritativeSnapshot: row.allows_authoritative_snapshot,
      minimumPreviousActive: row.closure_circuit_min_previous_active,
      maximumMissingRatio: Number(row.closure_circuit_max_missing_ratio),
      maximumMissingAbsolute: row.closure_circuit_max_missing_absolute,
    };
  }

  private async persistRecord(
    syncRunId: string,
    job: Awaited<ReturnType<SourceConnector["fetchRecord"]>>,
  ): Promise<{ recordCreated: boolean; versionCreated: boolean }> {
    const jsonContent = job.response.contentType?.includes("json") === true;
    const canonicalizationVersion = jsonContent ? "json-stable-v1" : "html-source-v1";
    const hashes = calculateContentHashes(job.raw, jsonContent ? stableJsonBytes : stableHtmlBytes, canonicalizationVersion);
    const storageKey = `raw/sha256/${hashes.rawHash.slice(0, 2)}/${hashes.rawHash}`;
    await this.objectStore.putIfAbsent(storageKey, job.raw, job.response.contentType);
    return this.db.transaction().execute(async (trx) => {
      const recordId = randomUUID();
      const insertedRecord = await sql<{ id: string; created: boolean }>`INSERT INTO source_job_records(
          id, source_instance_id, stable_key, external_id, canonical_url, normalized_application_url, last_seen_at
        ) VALUES (
          ${recordId}::uuid, ${job.identity.sourceInstanceId}::uuid, ${job.identity.stableKey},
          ${job.identity.externalId ?? null}, ${job.identity.canonicalUrl}, ${normalizeApplicationUrl(job.identity.canonicalUrl)}, now()
        ) ON CONFLICT (source_instance_id, stable_key) DO UPDATE SET
          external_id = EXCLUDED.external_id,
          canonical_url = EXCLUDED.canonical_url,
          normalized_application_url = EXCLUDED.normalized_application_url,
          last_seen_at = now()
        RETURNING id, (xmax = 0) AS created`.execute(trx);
      const persistedRecordId = insertedRecord.rows[0]?.id;
      if (persistedRecordId === undefined) throw new Error("failed to upsert source job record");
      const versionId = randomUUID();
      const insertedVersion = await sql<{ id: string }>`INSERT INTO source_job_versions(
          id, source_job_record_id, source_sync_run_id, raw_hash, content_hash,
          canonicalization_version, raw_storage_key, raw_byte_length, content_type,
          source_url, http_status, response_metadata, fetched_at
        ) VALUES (
          ${versionId}::uuid, ${persistedRecordId}::uuid, ${syncRunId}::uuid,
          ${hashes.rawHash}, ${hashes.contentHash}, ${hashes.canonicalizationVersion},
          ${storageKey}, ${job.raw.byteLength}, ${job.response.contentType}, ${job.response.finalUrl},
          ${job.response.status}, ${JSON.stringify(job.response)}::jsonb, ${job.response.fetchedAt}::timestamptz
        ) ON CONFLICT (source_job_record_id, raw_hash) DO NOTHING RETURNING id`.execute(trx);
      if (insertedVersion.rows[0] !== undefined) {
        await sql`INSERT INTO outbox_events(
          aggregate_type, aggregate_id, event_type, payload, dedup_key
        ) VALUES (
          'source_job_version', ${versionId}::uuid, 'source_job.raw_version_created',
          ${JSON.stringify({ sourceJobRecordId: persistedRecordId, sourceJobVersionId: versionId })}::jsonb,
          ${`raw-version-created:${persistedRecordId}:${hashes.rawHash}`}
        ) ON CONFLICT (dedup_key) DO NOTHING`.execute(trx);
      }
      return {
        recordCreated: Boolean(insertedRecord.rows[0]?.created),
        versionCreated: insertedVersion.rows[0] !== undefined,
      };
    });
  }

  private async finalizeRun(
    syncRunId: string,
    sourceInstanceId: string,
    snapshot: FinalizedSnapshot,
    persistedRecords: number,
  ): Promise<void> {
    const degraded = snapshot.kind === "partial";
    await this.db.transaction().execute(async (trx) => {
      await sql`UPDATE source_sync_runs SET status = 'succeeded', snapshot_kind = ${snapshot.kind}::snapshot_kind,
        page_count = ${snapshot.pageCount}, provider_total = ${snapshot.providerTotal ?? null},
        discovered_count = ${snapshot.jobs.length}, validation_result = ${JSON.stringify(snapshot.validation)}::jsonb,
        circuit_breaker_reason = ${snapshot.validation.circuitBreakerReasons}::text[], finished_at = now()
        WHERE id = ${syncRunId}::uuid`.execute(trx);
      await sql`UPDATE source_instances SET health_state = ${degraded ? "degraded" : "healthy"}::source_health_state,
        last_success_at = CASE WHEN ${degraded} THEN last_success_at ELSE now() END,
        last_failure_at = CASE WHEN ${degraded} THEN now() ELSE last_failure_at END,
        consecutive_failures = CASE WHEN ${degraded} THEN consecutive_failures + 1 ELSE 0 END, updated_at = now()
        WHERE id = ${sourceInstanceId}::uuid`.execute(trx);
      if (snapshot.validation.circuitBreakerReasons.length > 0) {
        await sql`INSERT INTO manual_review_tasks(source_instance_id, source_sync_run_id, reason, detail)
          VALUES (${sourceInstanceId}::uuid, ${syncRunId}::uuid, 'closure_circuit_breaker',
          ${JSON.stringify({ reasons: snapshot.validation.circuitBreakerReasons, persistedRecords })}::jsonb)`.execute(trx);
      }
    });
  }

  private async failRun(syncRunId: string, sourceInstanceId: string, error: unknown): Promise<void> {
    const code = error instanceof ConnectorError ? error.code : "unexpected";
    const detail = error instanceof Error ? error.message : String(error);
    await this.db.transaction().execute(async (trx) => {
      await sql`UPDATE source_sync_runs SET status='failed', snapshot_kind='partial', finished_at=now(),
        error_code=${code}, error_detail=${detail}, validation_result=${JSON.stringify({ error: detail })}::jsonb
        WHERE id=${syncRunId}::uuid`.execute(trx);
      await sql`UPDATE source_instances SET health_state='degraded', last_failure_at=now(),
        consecutive_failures=consecutive_failures+1, updated_at=now() WHERE id=${sourceInstanceId}::uuid`.execute(trx);
    });
  }
}

function stableJsonBytes(bytes: Uint8Array): Uint8Array {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return new TextEncoder().encode(stableJson(parsed));
}

function stableHtmlBytes(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(bytes).replaceAll("\r\n", "\n").trim();
  return new TextEncoder().encode(text);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(
      ([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function downgradeSnapshot(snapshot: FinalizedSnapshot, error: unknown): FinalizedSnapshot {
  return {
    ...snapshot,
    kind: "partial",
    validation: {
      ...snapshot.validation,
      parseErrors: [...snapshot.validation.parseErrors, error instanceof Error ? error.message : String(error)],
    },
  };
}

function emptySingleRecordSnapshot(source: SourceInstanceRef, note: string): FinalizedSnapshot {
  return {
    kind: "single_record", source, jobs: [], pageCount: 1, providerTotal: 0, finalizedAt: new Date().toISOString(),
    validation: { allPagesCompleted: true, parseErrors: [note], tenantIdentityConsistent: true,
      providerTotalMatched: true, circuitBreakerReasons: [] },
  };
}
