import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { DiscoveredJob, FinalizedSnapshot, SourceInstanceRef } from "../../contracts/src/index.js";
import type { OutboxDatabase } from "../../db/src/outbox.js";
import { LifecycleService } from "./lifecycle-service.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe.sequential;
const { Pool } = pg;

integration("persistent lifecycle safety", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool }) });
  afterAll(async () => db.destroy());

  it("enforces authoritative-only absence, minimum interval, closure, and recovery", async () => {
    const source: SourceInstanceRef = {
      id: randomUUID(), sourceKind: "greenhouse", tenantKey: `life-${randomUUID()}`, baseUrl: "https://example.com",
    };
    const recordA = randomUUID();
    const recordB = randomUUID();
    const syncRunId = randomUUID();
    await sql`INSERT INTO source_instances(id, source_kind, tenant_key, base_url) VALUES
      (${source.id}::uuid, 'greenhouse', ${source.tenantKey}, ${source.baseUrl})`.execute(db);
    await sql`INSERT INTO source_policies(source_instance_id, allows_authoritative_snapshot, required_missing_count, minimum_missing_interval)
      VALUES (${source.id}::uuid, true, 2, interval '12 hours')`.execute(db);
    await sql`INSERT INTO source_sync_runs(id, source_instance_id, idempotency_key)
      VALUES (${syncRunId}::uuid, ${source.id}::uuid, ${`life-${syncRunId}`})`.execute(db);
    await sql`INSERT INTO source_job_records(id, source_instance_id, stable_key, canonical_url) VALUES
      (${recordA}::uuid, ${source.id}::uuid, 'a', 'https://example.com/a'),
      (${recordB}::uuid, ${source.id}::uuid, 'b', 'https://example.com/b')`.execute(db);
    const service = new LifecycleService(db);
    const t0 = new Date("2026-07-13T00:00:00Z");
    await service.reconcileSnapshot(source.id, syncRunId, snapshot(source, "authoritative", [job(source, "a")]), t0);
    await expectState(db, recordB, "suspect", 1);
    await service.reconcileSnapshot(source.id, syncRunId, snapshot(source, "authoritative", [job(source, "a")]), new Date("2026-07-13T01:00:00Z"));
    await expectState(db, recordB, "suspect", 1);
    await service.reconcileSnapshot(source.id, syncRunId, snapshot(source, "partial", []), new Date("2026-07-14T00:00:00Z"));
    await expectState(db, recordB, "suspect", 1);
    await service.reconcileSnapshot(source.id, syncRunId, snapshot(source, "authoritative", [job(source, "a")]), new Date("2026-07-13T12:00:00Z"));
    await expectState(db, recordB, "closed", 2);
    await service.reconcileSnapshot(source.id, syncRunId, snapshot(source, "authoritative", [job(source, "a"), job(source, "b")]), new Date("2026-07-14T00:00:00Z"));
    await expectState(db, recordB, "active", 0);
    const transitions = await sql<{ count: string }>`SELECT count(*)::text AS count FROM job_state_transitions
      WHERE source_job_record_id = ${recordB}::uuid`.execute(db);
    expect(transitions.rows[0]?.count).toBe("3");
  });

  it("allows a single record to close only through an explicit allowed reason", async () => {
    const sourceId = randomUUID();
    const recordId = randomUUID();
    await sql`INSERT INTO source_instances(id, source_kind, tenant_key, base_url) VALUES
      (${sourceId}::uuid, 'manual', ${`single-${sourceId}`}, 'https://example.com')`.execute(db);
    await sql`INSERT INTO source_job_records(id, source_instance_id, stable_key, canonical_url) VALUES
      (${recordId}::uuid, ${sourceId}::uuid, 'single', 'https://example.com/single')`.execute(db);
    await new LifecycleService(db).closeSingleRecord(recordId, "manual_confirmation", new Date("2026-07-13T00:00:00Z"));
    await expectState(db, recordId, "closed", 0);
  });
});

function snapshot(source: SourceInstanceRef, kind: FinalizedSnapshot["kind"], jobs: DiscoveredJob[]): FinalizedSnapshot {
  return {
    source, kind, jobs, pageCount: 1, finalizedAt: "2026-07-13T00:00:00.000Z",
    validation: { allPagesCompleted: kind === "authoritative", parseErrors: [], tenantIdentityConsistent: true, providerTotalMatched: true, circuitBreakerReasons: [] },
  };
}

function job(source: SourceInstanceRef, stableKey: string): DiscoveredJob {
  const url = `https://example.com/${stableKey}`;
  return {
    identity: { sourceInstanceId: source.id, stableKey, canonicalUrl: url }, recordUrl: url,
    raw: new Uint8Array(),
    response: { requestedUrl: url, finalUrl: url, status: 200, fetchedAt: "2026-07-13T00:00:00.000Z", contentType: null, etag: null, lastModified: null, requestId: null },
  };
}

async function expectState(db: Kysely<OutboxDatabase>, recordId: string, state: string, missingCount: number): Promise<void> {
  const result = await sql<{ lifecycle_state: string; missing_count: number }>`SELECT lifecycle_state, missing_count
    FROM source_job_records WHERE id = ${recordId}::uuid`.execute(db);
  expect(result.rows[0]).toMatchObject({ lifecycle_state: state, missing_count: missingCount });
}

