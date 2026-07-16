import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SourceInstanceRef } from "../../contracts/src/index.js";
import { AshbyConnector, LeverConnector, SmartRecruitersConnector } from "./public-ats-connectors.js";

describe("public ATS connectors", () => {
  it("paginates SmartRecruiters by provider total and fetches exact details", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/postings/2")) return json({ id: "2", name: "Web Engineer",
        postingUrl: "https://jobs.smartrecruiters.com/acme/2-web-engineer", releasedDate: "2026-07-14T00:00:00Z" });
      const offset = Number(url.searchParams.get("offset"));
      return json({ offset, limit: 1, totalFound: 2, content: [{ id: String(offset + 1), name: `Job ${offset + 1}`,
        ref: `https://api.smartrecruiters.com/v1/companies/acme/postings/${offset + 1}` }] });
    });
    const connector = new SmartRecruitersConnector(fetcher);
    const source = fixtureSource("smartrecruiters", "acme", "https://jobs.smartrecruiters.com/acme");
    const first = await connector.fetchCollectionPage({ source, signal: AbortSignal.timeout(1_000) });
    expect(first).toMatchObject({ isLastPage: false, nextCursor: "1", providerTotal: 2 });
    const second = await connector.fetchCollectionPage({ source, cursor: "1", signal: AbortSignal.timeout(1_000) });
    expect(second).toMatchObject({ isLastPage: true, providerTotal: 2 });
    const detail = await connector.fetchRecord(second.jobs[0]!.identity, AbortSignal.timeout(1_000));
    expect(detail.identity.canonicalUrl).toBe("https://jobs.smartrecruiters.com/acme/2-web-engineer");
  });

  it("uses Lever skip pagination and published hosted URLs", async () => {
    const postings = Array.from({ length: 100 }, (_, index) => ({ id: `id-${index}`, text: `Role ${index}`,
      hostedUrl: `https://jobs.lever.co/acme/id-${index}`, categories: { location: "Tokyo, Japan" } }));
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (/\/postings\/acme\/id-0$/.test(url.pathname)) return json(postings[0]);
      return json(url.searchParams.get("skip") === "0" ? postings : []);
    });
    const connector = new LeverConnector(fetcher);
    const source = fixtureSource("lever", "acme", "https://jobs.lever.co/acme");
    const first = await connector.fetchCollectionPage({ source, signal: AbortSignal.timeout(1_000) });
    expect(first).toMatchObject({ isLastPage: false, nextCursor: "100" });
    const second = await connector.fetchCollectionPage({ source, cursor: "100", signal: AbortSignal.timeout(1_000) });
    expect(second).toMatchObject({ isLastPage: true });
    const detail = await connector.fetchRecord(first.jobs[0]!.identity, AbortSignal.timeout(1_000));
    expect(detail.identity.externalId).toBe("id-0");
  });

  it("filters unlisted Ashby jobs and reuses the board response for record fetches", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ jobs: [
      { title: "AI Engineer", location: "Tokyo, Japan", publishedAt: "2026-07-01T00:00:00Z", isListed: true,
        jobUrl: "https://jobs.ashbyhq.com/acme/11111111-1111-4111-8111-111111111111", applyUrl: "https://jobs.ashbyhq.com/acme/111/application" },
      { title: "Hidden", location: "Tokyo", isListed: false,
        jobUrl: "https://jobs.ashbyhq.com/acme/22222222-2222-4222-8222-222222222222" },
    ] }));
    const connector = new AshbyConnector(fetcher);
    const source = fixtureSource("ashby", "acme", "https://jobs.ashbyhq.com/acme");
    const page = await connector.fetchCollectionPage({ source, signal: AbortSignal.timeout(1_000) });
    expect(page.jobs).toHaveLength(1);
    const detail = await connector.fetchRecord(page.jobs[0]!.identity, AbortSignal.timeout(1_000));
    expect(detail.identity.stableKey).toBe("11111111-1111-4111-8111-111111111111");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

function fixtureSource(kind: SourceInstanceRef["sourceKind"], tenantKey: string, baseUrl: string): SourceInstanceRef {
  return { id: randomUUID(), sourceKind: kind, tenantKey, baseUrl };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
