import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { ConnectorError, type CollectionPageRequest, type DiscoveredJob, type SourceConnector, type SourceInstanceRef, type SourceJobIdentity } from "../../contracts/src/index.js";
import { GreenhouseConnector } from "../../connectors-greenhouse/src/greenhouse-connector.js";
import { SchemaOrgConnector } from "../../connectors-schema-org/src/schema-org-connector.js";
import type { OutboxDatabase } from "../../db/src/outbox.js";
import { MemoryRawObjectStore } from "../../storage/src/object-store.js";
import { SourceSyncService } from "./source-sync-service.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe.sequential;
const { Pool } = pg;

integration("verified Greenhouse full sync", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool }) });

  afterAll(async () => db.destroy());

  it("replays ten syncs without duplicating records, raw versions, objects, or events", async () => {
    const source: SourceInstanceRef = {
      id: randomUUID(),
      sourceKind: "greenhouse",
      tenantKey: `fixture-${randomUUID()}`,
      baseUrl: "https://boards-api.greenhouse.io",
    };
    await sql`INSERT INTO source_instances(id, source_kind, tenant_key, base_url, verification_state)
      VALUES (${source.id}::uuid, 'greenhouse', ${source.tenantKey}, ${source.baseUrl}, 'verified')`.execute(db);
    await sql`INSERT INTO source_policies(source_instance_id, allows_authoritative_snapshot)
      VALUES (${source.id}::uuid, true)`.execute(db);

    const fixtureJobs = [
      { id: 101, title: "Frontend Engineer", absolute_url: `https://job-boards.greenhouse.io/${source.tenantKey}/jobs/101`, location: { name: "Tokyo" } },
      { id: 102, title: "Product Manager", absolute_url: `https://job-boards.greenhouse.io/${source.tenantKey}/jobs/102`, location: { name: "Hybrid" } },
    ];
    const connector = new GreenhouseConnector(async (input) => {
      const url = String(input);
      const record = fixtureJobs.find((job) => url.endsWith(`/jobs/${job.id}`));
      return new Response(JSON.stringify(record ?? { jobs: fixtureJobs, meta: { total: 2 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const store = new MemoryRawObjectStore();
    const service = new SourceSyncService(db, connector, store);
    const results = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      results.push(await service.run({ source, idempotencyKey: `fixture-run-${attempt}` }));
      if (attempt === 0) {
        await sql`UPDATE source_job_records SET last_seen_at='2020-01-01T00:00:00Z'
          WHERE source_instance_id=${source.id}::uuid`.execute(db);
      }
    }
    expect(results.every((result) => result.snapshot?.kind === "authoritative")).toBe(true);
    const counts = await sql<{ records: string; versions: string; events: string; runs: string }>`SELECT
      (SELECT count(*)::text FROM source_job_records WHERE source_instance_id = ${source.id}::uuid) AS records,
      (SELECT count(*)::text FROM source_job_versions v JOIN source_job_records r ON r.id = v.source_job_record_id WHERE r.source_instance_id = ${source.id}::uuid) AS versions,
      (SELECT count(*)::text FROM outbox_events WHERE event_type = 'source_job.raw_version_created' AND payload->>'sourceJobRecordId' IN
        (SELECT id::text FROM source_job_records WHERE source_instance_id = ${source.id}::uuid)) AS events,
      (SELECT count(*)::text FROM source_sync_runs WHERE source_instance_id = ${source.id}::uuid) AS runs`.execute(db);
    expect(counts.rows[0]).toEqual({ records: "2", versions: "2", events: "2", runs: "10" });
    const confirmations = await sql<{ all_recent: boolean }>`SELECT bool_and(last_seen_at > '2020-01-01T00:00:00Z') all_recent
      FROM source_job_records WHERE source_instance_id=${source.id}::uuid`.execute(db);
    expect(confirmations.rows[0]?.all_recent).toBe(true);
    expect(store.objects.size).toBe(2);
  });

  it("closes only the matching existing single record on HTTP 410", async () => {
    const source: SourceInstanceRef = { id: randomUUID(), sourceKind: "schema_org", tenantKey: `gone-${randomUUID()}`, baseUrl: "https://example.com" };
    const recordId = randomUUID();
    await sql`INSERT INTO source_instances(id, source_kind, tenant_key, base_url, verification_state)
      VALUES (${source.id}::uuid, 'schema_org', ${source.tenantKey}, ${source.baseUrl}, 'verified')`.execute(db);
    await sql`INSERT INTO source_policies(source_instance_id, allows_authoritative_snapshot) VALUES (${source.id}::uuid, false)`.execute(db);
    await sql`INSERT INTO source_job_records(id, source_instance_id, stable_key, canonical_url)
      VALUES (${recordId}::uuid, ${source.id}::uuid, 'gone', 'https://example.com/gone')`.execute(db);
    const connector = failingConnector("record_closed");
    const result = await new SourceSyncService(db, connector, new MemoryRawObjectStore()).run({
      source, idempotencyKey: `gone-${randomUUID()}`,
      recordIdentity: { sourceInstanceId: source.id, stableKey: "gone", canonicalUrl: "https://example.com/gone" },
    });
    expect(result.snapshot?.kind).toBe("single_record");
    const record = await sql<{ lifecycle_state: string }>`SELECT lifecycle_state FROM source_job_records WHERE id=${recordId}::uuid`.execute(db);
    expect(record.rows[0]?.lifecycle_state).toBe("closed");
  });

  it("persists a successful schema.org source only as a single-record snapshot", async () => {
    const source: SourceInstanceRef = { id: randomUUID(), sourceKind: "schema_org", tenantKey: `schema-${randomUUID()}`, baseUrl: "https://careers.example.com" };
    await sql`INSERT INTO source_instances(id, source_kind, tenant_key, base_url, verification_state)
      VALUES (${source.id}::uuid, 'schema_org', ${source.tenantKey}, ${source.baseUrl}, 'verified')`.execute(db);
    await sql`INSERT INTO source_policies(source_instance_id, allows_authoritative_snapshot) VALUES (${source.id}::uuid, false)`.execute(db);
    const url = "https://careers.example.com/jobs/27";
    const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", identifier: { value: "27" }, title: "Engineer", url })}</script>`;
    const connector = new SchemaOrgConnector(async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }), async () => ["203.0.113.10"]);
    const result = await new SourceSyncService(db, connector, new MemoryRawObjectStore()).run({
      source, idempotencyKey: `schema-${randomUUID()}`,
      recordIdentity: { sourceInstanceId: source.id, stableKey: "page", canonicalUrl: url },
    });
    expect(result).toMatchObject({ snapshot: { kind: "single_record" }, persistedRecords: 1, persistedVersions: 1 });
    const count = await sql<{ count: string }>`SELECT count(*)::text AS count FROM source_job_records WHERE source_instance_id=${source.id}::uuid`.execute(db);
    expect(count.rows[0]?.count).toBe("1");
  });

  it("finishes a forbidden single-record run as failed and only degrades source health", async () => {
    const source: SourceInstanceRef = { id: randomUUID(), sourceKind: "schema_org", tenantKey: `forbidden-${randomUUID()}`, baseUrl: "https://example.com" };
    await sql`INSERT INTO source_instances(id, source_kind, tenant_key, base_url, verification_state)
      VALUES (${source.id}::uuid, 'schema_org', ${source.tenantKey}, ${source.baseUrl}, 'verified')`.execute(db);
    await sql`INSERT INTO source_policies(source_instance_id, allows_authoritative_snapshot) VALUES (${source.id}::uuid, false)`.execute(db);
    await expect(new SourceSyncService(db, failingConnector("forbidden"), new MemoryRawObjectStore()).run({
      source, idempotencyKey: `forbidden-${randomUUID()}`,
      recordIdentity: { sourceInstanceId: source.id, stableKey: "job", canonicalUrl: "https://example.com/job" },
    })).rejects.toMatchObject({ code: "forbidden" });
    const state = await sql<{ health_state: string; status: string }>`SELECT s.health_state, r.status FROM source_instances s
      JOIN source_sync_runs r ON r.source_instance_id=s.id WHERE s.id=${source.id}::uuid`.execute(db);
    expect(state.rows[0]).toEqual({ health_state: "degraded", status: "failed" });
  });
});

function failingConnector(code: "record_closed" | "forbidden"): SourceConnector {
  return {
    kind: "schema_org",
    async fetchCollectionPage(_request: CollectionPageRequest) { throw new Error("not used"); },
    async fetchRecord(_identity: SourceJobIdentity): Promise<DiscoveredJob> {
      throw new ConnectorError(code, code, false);
    },
  };
}
