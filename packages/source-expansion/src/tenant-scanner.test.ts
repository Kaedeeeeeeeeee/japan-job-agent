import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scanTenant } from "./tenant-scanner.js";
import type { ClaimedTenant } from "./source-expansion-store.js";

describe("ranked tenant scanner", () => {
  it("keeps only explicit recent Japan jobs and rejects old, future, unknown-date, and overseas jobs", async () => {
    const jobs = [
      job(1, "Tokyo, Japan", "2026-07-15T00:00:00Z"),
      job(2, "Tokyo, Japan", "2026-05-01T00:00:00Z"),
      job(3, "Tokyo, Japan", "2026-07-19T00:00:00Z"),
      job(4, "Tokyo, Japan", undefined),
      job(5, "London, United Kingdom", "2026-07-15T00:00:00Z"),
    ];
    const result = await scanTenant({ tenant: tenant("greenhouse"), discoverySourceId: randomUUID(), backfillDays: 30,
      now: new Date("2026-07-18T03:00:00Z"), signal: AbortSignal.timeout(1_000),
      fetchImplementation: async () => json({ jobs, meta: { total: jobs.length } }) });
    expect(result.snapshot.kind).toBe("authoritative");
    expect(result.leads.map((lead) => lead.externalPostingId)).toEqual(["1"]);
    expect(result.excludedOutsideWindow).toBe(2);
    expect(result.excludedUnknownPublication).toBe(1);
    expect(result.excludedNonJapan).toBe(1);
  });

  it("returns a partial snapshot on 429 without admitting candidates", async () => {
    const result = await scanTenant({ tenant: tenant("greenhouse"), discoverySourceId: randomUUID(), backfillDays: 30,
      now: new Date("2026-07-18T03:00:00Z"), signal: AbortSignal.timeout(1_000),
      fetchImplementation: async () => new Response("slow down", { status: 429 }) });
    expect(result.snapshot.kind).toBe("partial");
    expect(result.snapshot.validation.parseErrors.join(" ")).toMatch(/rate limited/i);
    expect(result.leads).toHaveLength(0);
  });

  it("exposes an empty authoritative collection so the caller can apply its empty-set circuit breaker", async () => {
    const result = await scanTenant({ tenant: tenant("greenhouse"), discoverySourceId: randomUUID(), backfillDays: 30,
      now: new Date("2026-07-18T03:00:00Z"), signal: AbortSignal.timeout(1_000),
      fetchImplementation: async () => json({ jobs: [], meta: { total: 0 } }) });
    expect(result.snapshot.kind).toBe("authoritative");
    expect(result.snapshot.jobs).toHaveLength(0);
    expect(result.leads).toHaveLength(0);
  });
});

function tenant(sourceKind: ClaimedTenant["sourceKind"]): ClaimedTenant {
  return { id: randomUUID(), sourceKind, tenantKey: "acme", companyName: "Acme", japanSignal: true,
    sourceUrl: "https://boards.greenhouse.io/acme", officialReferrerUrl: "https://acme.example/careers" };
}

function job(id: number, location: string, firstPublished: string | undefined): Record<string, unknown> {
  return { id, title: `Engineer ${id}`, absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    location: { name: location }, ...(firstPublished === undefined ? {} : { first_published: firstPublished }) };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
