import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.js";
import type { OutboxDatabase } from "../../db/src/outbox.js";
import { SourceExpansionStore } from "./source-expansion-store.js";
import { tenantCandidateArtifactSchema } from "./tenant-artifact.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe.sequential;
const { Pool } = pg;

integration("source tenant expansion persistence", () => {
  const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl }) }) });
  const store = new SourceExpansionStore(db);
  const suffix = randomUUID().slice(0, 8);
  const tenantKeys = [`acme-${suffix}`, `example-${suffix}`];
  const sourceIds: string[] = [];

  beforeAll(async () => migrate(databaseUrl));

  afterAll(async () => {
    await sql`DELETE FROM source_tenant_candidates WHERE tenant_key IN (${sql.join(tenantKeys.map((key) => sql`${key}`))})`.execute(db);
    if (sourceIds.length > 0) await sql`DELETE FROM source_instances WHERE id IN (${sql.join(sourceIds.map((id) => sql`${id}::uuid`))})`.execute(db);
    await db.destroy();
  });

  it("imports idempotently, isolates Discovery, and claims each tenant once under concurrency", async () => {
    const artifact = tenantCandidateArtifactSchema.parse({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      generator: "integration-test",
      requestBudget: 1,
      requestsUsed: 1,
      truncated: false,
      candidates: [
        { sourceKind: "ashby", tenantKey: tenantKeys[0], sourceUrl: `https://jobs.ashbyhq.com/${tenantKeys[0]}`,
          discoveredVia: "operator", evidence: {} },
        { sourceKind: "lever", tenantKey: tenantKeys[1], sourceUrl: `https://jobs.lever.co/${tenantKeys[1]}`,
          discoveredVia: "operator", evidence: {} },
      ],
      summary: { ashby: 1, lever: 1 },
    });
    const first = await store.importArtifact(artifact, true);
    const replay = await store.importArtifact(artifact, true);
    expect(first).toMatchObject({ inserted: 2, updated: 0 });
    expect(replay).toMatchObject({ inserted: 0, updated: 2 });
    const [left, right] = await Promise.all([
      store.claimTenants(`worker-left-${suffix}`, 1, 60_000, 30),
      store.claimTenants(`worker-right-${suffix}`, 1, 60_000, 30),
    ]);
    expect(left).toHaveLength(1);
    expect(right).toHaveLength(1);
    expect(left[0]?.id).not.toBe(right[0]?.id);
    const leaked = await sql<{ count: number }>`SELECT count(*)::int count FROM job_discovery_candidates
      WHERE tenant_key IN (${sql.join(tenantKeys.map((key) => sql`${key}`))})`.execute(db);
    expect(leaked.rows[0]?.count).toBe(0);
  });

  it("enforces the verified transition evidence pointer", async () => {
    const candidate = (await sql<{ id: string; source_kind: "ashby" | "lever"; tenant_key: string }>`SELECT
      id,source_kind,tenant_key FROM source_tenant_candidates WHERE tenant_key=${tenantKeys[0]}`.execute(db)).rows[0]!;
    await expect(sql`UPDATE source_tenant_candidates SET review_state='verified',verified_at=now()
      WHERE id=${candidate.id}::uuid`.execute(db)).rejects.toThrow();
    const sourceId = randomUUID();
    sourceIds.push(sourceId);
    await sql`INSERT INTO source_instances(id,source_kind,tenant_key,base_url,verification_state)
      VALUES (${sourceId}::uuid,${candidate.source_kind}::source_kind,${candidate.tenant_key},
        ${`https://jobs.ashbyhq.com/${candidate.tenant_key}`},'verified')`.execute(db);
    await sql`UPDATE source_tenant_candidates SET review_state='verified',verified_at=now(),
      linked_source_instance_id=${sourceId}::uuid,lease_owner=NULL,lease_expires_at=NULL,claimed_from_state=NULL
      WHERE id=${candidate.id}::uuid`.execute(db);
    const state = await sql<{ review_state: string }>`SELECT review_state FROM source_tenant_candidates
      WHERE id=${candidate.id}::uuid`.execute(db);
    expect(state.rows[0]?.review_state).toBe("verified");
  });
});
