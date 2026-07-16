import { createHash, randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobDiscoveryLead } from "../../contracts/src/index.js";
import type { OutboxDatabase } from "../../db/src/outbox.js";
import { migrate } from "../../db/src/migrate.js";
import {
  classifyJapanLocation,
  JobDiscoveryService,
  weakSimilarityClusterKey,
} from "./job-discovery-service.js";

describe("job discovery admission", () => {
  it("only admits deterministic Japan locations and keeps global remote unknown", () => {
    expect(classifyJapanLocation("Tokyo, Japan / Hybrid")).toBe("japan");
    expect(classifyJapanLocation("日本全国・フルリモート")).toBe("japan");
    expect(classifyJapanLocation("石川県 金沢市 JP")).toBe("japan");
    expect(classifyJapanLocation("群馬県高崎市")).toBe("japan");
    expect(classifyJapanLocation("Taipei, Taiwan")).toBe("non_japan");
    expect(classifyJapanLocation("Remote - anywhere")).toBe("unknown");
  });

  it("uses weak title/company/location similarity only as a stable review key", () => {
    const first = weakSimilarityClusterKey("株式会社 Example", "Web Engineer", "Tokyo");
    const second = weakSimilarityClusterKey("Example Inc.", "Web  Engineer", "Tokyo");
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe.sequential;
const { Pool } = pg;
let authoritativeImportRunId: string | undefined;

integration("job discovery persistence and promotion leases", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool }) });
  const service = new JobDiscoveryService(db);
  let discoverySourceId: string;

  beforeAll(async () => {
    await migrate(databaseUrl);
    discoverySourceId = randomUUID();
    await sql`INSERT INTO discovery_sources(id,source_key,name,source_kind,base_url)
      VALUES (${discoverySourceId}::uuid,${`fixture-${discoverySourceId}`},'Fixture public ATS','public_ats','https://example.com')`.execute(db);
    authoritativeImportRunId = await service.recordFinalizedAuthoritativeImport({
      discoverySourceId,
      idempotencyKey: "fixture-complete-snapshot",
      pageCount: 2,
      providerTotal: 24,
      discoveredCount: 24,
      rawHash: createHash("sha256").update("fixture-complete-snapshot").digest("hex"),
      validation: { allPagesCompleted: true, tenantIdentityConsistent: true, providerTotalMatched: true, parseErrors: [] },
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("replays one import ten times without duplicating candidates or observations", async () => {
    const lead = fixtureLead(discoverySourceId, "ten-replays", "official_collection", true, "Tokyo, Japan");
    const results = [];
    for (let index = 0; index < 10; index += 1) results.push(await service.ingest(lead));
    expect(results.filter((result) => result.candidateCreated)).toHaveLength(1);
    expect(results.filter((result) => result.observationCreated)).toHaveLength(1);
    expect(results.at(-1)?.countable).toBe(true);
    const counts = await sql<{ candidates: number; observations: number; source_records: number }>`SELECT
      count(DISTINCT c.id)::int candidates,count(o.id)::int observations,
      (SELECT count(*)::int FROM source_job_records r WHERE r.canonical_url=${lead.detailUrl}) source_records
      FROM job_discovery_candidates c LEFT JOIN job_discovery_observations o ON o.candidate_id=c.id
      WHERE c.external_key=${lead.externalKey}`.execute(db);
    expect(counts.rows[0]).toEqual({ candidates: 1, observations: 1, source_records: 0 });
  });

  it("does not grant authority before the collection run is completely finalized", async () => {
    await expect(service.recordFinalizedAuthoritativeImport({
      discoverySourceId,
      idempotencyKey: "fixture-missing-page",
      pageCount: 1,
      providerTotal: 2,
      discoveredCount: 1,
      rawHash: createHash("sha256").update("fixture-missing-page").digest("hex"),
      validation: { allPagesCompleted: false, tenantIdentityConsistent: true, providerTotalMatched: false,
        parseErrors: ["page 2 missing"] },
    })).rejects.toThrow("cannot become an authoritative");
    const completeLead = fixtureLead(discoverySourceId, "missing-finalized-run", "official_collection", true, "Tokyo");
    const missingRun = { ...completeLead };
    delete missingRun.discoveryImportRunId;
    await expect(service.ingest(missingRun)).rejects.toThrow("require a finalized import run");
  });

  it("requires two recent observations for non-official leads", async () => {
    const first = fixtureLead(discoverySourceId, "aggregator", "aggregator_lead", false, "東京都");
    const created = await service.ingest(first);
    expect(created.countable).toBe(false);
    const observedAgain = await service.ingest({ ...first, observationKey: `${first.observationKey}:second`,
      observedAt: "2026-07-14T01:00:00.000Z" });
    expect(observedAgain.countable).toBe(true);
    await service.ingest({ ...first, observationKey: `${first.observationKey}:second`,
      observedAt: "2026-07-15T01:00:00.000Z" });
    const freshness = await sql<{ observation_count: number; last_seen_at: Date }>`SELECT observation_count,last_seen_at
      FROM job_discovery_candidates WHERE id=${observedAgain.candidateId}::uuid`.execute(db);
    expect(freshness.rows[0]?.observation_count).toBe(2);
    expect(freshness.rows[0]?.last_seen_at.toISOString()).toBe("2026-07-14T01:00:00.000Z");
  });

  it("uses SKIP LOCKED so two workers claim one promotion once", async () => {
    const sourceId = randomUUID();
    const companyId = randomUUID();
    const relationshipId = randomUUID();
    const evidenceId = randomUUID();
    await sql`INSERT INTO source_instances(id,source_kind,tenant_key,base_url,verification_state)
      VALUES (${sourceId}::uuid,'manual',${`promotion-${sourceId}`},'https://example.com/jobs','verified')`.execute(db);
    await sql`INSERT INTO companies(id,legal_name,display_name) VALUES
      (${companyId}::uuid,${`Company ${companyId}`},'Fixture Company')`.execute(db);
    await sql`INSERT INTO company_source_relationships(id,company_id,source_instance_id,relationship_kind,verification_state,valid_from)
      VALUES (${relationshipId}::uuid,${companyId}::uuid,${sourceId}::uuid,'official_owner','verified',now())`.execute(db);
    await sql`INSERT INTO evidence(id,kind,company_source_relationship_id,field_path,quoted_text,source_url,locator)
      VALUES (${evidenceId}::uuid,'ats_link',${relationshipId}::uuid,'sourceRelationship','Official jobs',
      'https://example.com/careers','{}'::jsonb)`.execute(db);
    const lead = fixtureLead(discoverySourceId, `promotion-${sourceId}`, "official_collection", true, "Japan");
    const ingested = await service.ingest(lead);
    await service.applyResolution(ingested.candidateId, { status: "resolved", officialUrl: lead.detailUrl,
      sourceInstanceId: sourceId, evidenceIds: [evidenceId] });
    const attemptId = await service.enqueuePromotion(ingested.candidateId, "fixture-promotion");
    expect(await service.enqueuePromotion(ingested.candidateId, "fixture-promotion")).toBe(attemptId);
    const [first, second] = await Promise.all([
      service.claimPromotionAttempts("worker-a", 1),
      service.claimPromotionAttempts("worker-b", 1),
    ]);
    expect(first.length + second.length).toBe(1);
    const claimed = first[0] ?? second[0];
    expect(claimed?.id).toBe(attemptId);
    expect(claimed?.attemptCount).toBe(1);
    await sql`UPDATE job_promotion_attempts SET leased_at=now()-interval '10 minutes',
      lease_expires_at=now()-interval '1 second'
      WHERE id=${attemptId}::uuid`.execute(db);
    const recovered = await service.claimPromotionAttemptById(attemptId, "worker-c");
    expect(recovered?.id).toBe(attemptId);
    expect(recovered?.attemptCount).toBe(2);
  });

  it("claims a 50/25/25 weighted batch and lends unused capacity", async () => {
    const sourceId = randomUUID();
    const companyId = randomUUID();
    const relationshipId = randomUUID();
    const evidenceId = randomUUID();
    await sql`INSERT INTO source_instances(id,source_kind,tenant_key,base_url,verification_state)
      VALUES (${sourceId}::uuid,'manual',${`weighted-${sourceId}`},'https://weighted.example/jobs','verified')`.execute(db);
    await sql`INSERT INTO companies(id,legal_name,display_name) VALUES
      (${companyId}::uuid,${`Weighted ${companyId}`},'Weighted Fixture')`.execute(db);
    await sql`INSERT INTO company_source_relationships(id,company_id,source_instance_id,relationship_kind,verification_state,valid_from)
      VALUES (${relationshipId}::uuid,${companyId}::uuid,${sourceId}::uuid,'official_owner','verified',now())`.execute(db);
    await sql`INSERT INTO evidence(id,kind,company_source_relationship_id,field_path,quoted_text,source_url,locator)
      VALUES (${evidenceId}::uuid,'ats_link',${relationshipId}::uuid,'sourceRelationship','Official jobs',
      'https://weighted.example/careers','{}'::jsonb)`.execute(db);
    const lanes = [...Array(8).fill("p0"), ...Array(8).fill("p1"), ...Array(8).fill("p2")] as Array<"p0" | "p1" | "p2">;
    for (const [index, priority] of lanes.entries()) {
      const lead = { ...fixtureLead(discoverySourceId, `weighted-${sourceId}-${index}`, "official_collection", true, "Tokyo"), priority };
      const ingested = await service.ingest(lead);
      await service.applyResolution(ingested.candidateId, { status: "resolved", officialUrl: lead.detailUrl,
        sourceInstanceId: sourceId, evidenceIds: [evidenceId] });
      await service.enqueuePromotion(ingested.candidateId, `weighted-${sourceId}-${index}`);
    }
    const claimed = await service.claimPromotionAttempts(`weighted-worker-${sourceId}`, 8);
    const priorities = await sql<{ priority: string; count: number }>`SELECT c.priority,count(*)::int count
      FROM job_promotion_attempts a JOIN job_discovery_candidates c ON c.id=a.candidate_id
      WHERE a.id IN (${sql.join(claimed.map((attempt) => sql`${attempt.id}::uuid`))}) GROUP BY c.priority`.execute(db);
    expect(Object.fromEntries(priorities.rows.map((row) => [row.priority, row.count]))).toEqual({ p0: 4, p1: 2, p2: 2 });

    await sql`DELETE FROM job_discovery_candidates WHERE external_key LIKE ${`weighted-${sourceId}-%`}`.execute(db);

    for (let index = 0; index < 4; index += 1) {
      const lead = fixtureLead(discoverySourceId, `borrow-${sourceId}-${index}`, "official_collection", true, "Tokyo");
      const ingested = await service.ingest(lead);
      await service.applyResolution(ingested.candidateId, { status: "resolved", officialUrl: lead.detailUrl,
        sourceInstanceId: sourceId, evidenceIds: [evidenceId] });
      await service.enqueuePromotion(ingested.candidateId, `borrow-${sourceId}-${index}`);
    }
    const borrowed = await service.claimPromotionAttempts(`borrow-worker-${sourceId}`, 4);
    expect(borrowed).toHaveLength(4);
  });
});

function fixtureLead(
  discoverySourceId: string,
  key: string,
  originKind: JobDiscoveryLead["originKind"],
  authoritative: boolean,
  locationText: string,
): JobDiscoveryLead {
  const detailUrl = `https://example.com/jobs/${key}`;
  const payload = JSON.stringify({ key, locationText });
  return {
    discoverySourceId,
    originKind,
    sourceFamily: originKind === "aggregator_lead" ? "fixture-aggregator" : "fixture-ats",
    sourceKindHint: "manual",
    tenantKey: "fixture",
    externalPostingId: key,
    externalKey: key,
    detailUrl,
    companyName: "Example Inc.",
    title: `Engineer ${key}`,
    locationText,
    priority: "p0",
    observationKey: `fixture:${key}:2026-07-14`,
    payloadHash: createHash("sha256").update(payload).digest("hex"),
    observedAt: "2026-07-14T00:00:00.000Z",
    authoritative,
    ...(authoritative && authoritativeImportRunId !== undefined ? { discoveryImportRunId: authoritativeImportRunId } : {}),
    responseMetadata: { fixture: true },
  };
}
