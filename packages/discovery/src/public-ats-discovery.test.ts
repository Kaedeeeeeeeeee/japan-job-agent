import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AshbyConnector } from "../../connectors-public-ats/src/public-ats-connectors.js";
import { collectPublicAtsDiscovery } from "./public-ats-discovery.js";

describe("public ATS discovery", () => {
  it("only emits current authoritative Japan leads with source dates", async () => {
    const connector = new AshbyConnector(async () => new Response(JSON.stringify({ jobs: [
      { title: "AI Engineer", location: "Tokyo, Japan", publishedAt: "2026-07-01T09:00:00+09:00", isListed: true,
        jobUrl: "https://jobs.ashbyhq.com/acme/11111111-1111-4111-8111-111111111111" },
      { title: "Engineer", location: "London, United Kingdom", isListed: true,
        jobUrl: "https://jobs.ashbyhq.com/acme/22222222-2222-4222-8222-222222222222" },
      { title: "Remote Engineer", location: "Remote - anywhere", isListed: true,
        jobUrl: "https://jobs.ashbyhq.com/acme/33333333-3333-4333-8333-333333333333" },
    ] }), { status: 200, headers: { "content-type": "application/json" } }));
    const source = { id: randomUUID(), sourceKind: "ashby" as const, tenantKey: "acme", baseUrl: "https://jobs.ashbyhq.com/acme" };
    const result = await collectPublicAtsDiscovery(connector, source, { kind: "ashby", tenantKey: "acme", companyName: "Acme" },
      randomUUID(), AbortSignal.timeout(1_000));
    expect(result.snapshot.kind).toBe("authoritative");
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]).toMatchObject({
      title: "AI Engineer",
      locationText: "Tokyo, Japan",
      authoritative: true,
      published: { value: "2026-07-01T00:00:00.000Z", precision: "datetime" },
    });
    expect(result.excludedNonJapan).toBe(1);
    expect(result.excludedUnknownLocation).toBe(1);
  });
});
