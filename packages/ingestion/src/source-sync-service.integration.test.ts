import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { SourceInstanceRef } from "../../contracts/src/index.js";
import { GreenhouseConnector } from "../../connectors-greenhouse/src/greenhouse-connector.js";
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
    }
    expect(results.every((result) => result.snapshot?.kind === "authoritative")).toBe(true);
    const counts = await sql<{ records: string; versions: string; events: string; runs: string }>`SELECT
      (SELECT count(*)::text FROM source_job_records WHERE source_instance_id = ${source.id}::uuid) AS records,
      (SELECT count(*)::text FROM source_job_versions v JOIN source_job_records r ON r.id = v.source_job_record_id WHERE r.source_instance_id = ${source.id}::uuid) AS versions,
      (SELECT count(*)::text FROM outbox_events WHERE event_type = 'source_job.raw_version_created' AND payload->>'sourceJobRecordId' IN
        (SELECT id::text FROM source_job_records WHERE source_instance_id = ${source.id}::uuid)) AS events,
      (SELECT count(*)::text FROM source_sync_runs WHERE source_instance_id = ${source.id}::uuid) AS runs`.execute(db);
    expect(counts.rows[0]).toEqual({ records: "2", versions: "2", events: "2", runs: "10" });
    expect(store.objects.size).toBe(2);
  });
});

