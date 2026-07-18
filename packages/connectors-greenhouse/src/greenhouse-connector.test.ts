import { describe, expect, it } from "vitest";
import type { SourceInstanceRef } from "../../contracts/src/index.js";
import { GreenhouseConnector } from "./greenhouse-connector.js";

const source: SourceInstanceRef = {
  id: "11111111-1111-4111-8111-111111111111",
  sourceKind: "greenhouse",
  tenantKey: "paypay",
  baseUrl: "https://boards-api.greenhouse.io",
};

const jobs = {
  jobs: [
    { id: 123, title: "Software Engineer", absolute_url: "https://job-boards.greenhouse.io/paypay/jobs/123", location: { name: "Tokyo" } },
    { id: 456, title: "Product Manager", absolute_url: "https://job-boards.greenhouse.io/paypay/jobs/456", location: { name: "Hybrid" } },
  ],
  meta: { total: 2 },
};

describe("GreenhouseConnector", () => {
  it("returns a page that cannot declare authority", async () => {
    const connector = new GreenhouseConnector(async (input) => new Response(JSON.stringify(jobs), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as never);
    const page = await connector.fetchCollectionPage({ source, signal: AbortSignal.timeout(1_000) });
    expect(page).toMatchObject({ isLastPage: true, providerTotal: 2 });
    expect(page.jobs.map((job) => job.identity.stableKey)).toEqual(["123", "456"]);
    expect(page).not.toHaveProperty("authoritative");
  });

  it("maps rate limiting to the shared connector error", async () => {
    const connector = new GreenhouseConnector(async () => new Response("slow down", { status: 429 }) as never);
    await expect(connector.fetchCollectionPage({ source, signal: AbortSignal.timeout(1_000) }))
      .rejects.toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("keeps the exact record endpoint bytes for immutable raw storage", async () => {
    const exact = '{ "id": 123, "title": "Software Engineer", "first_published": "2026-07-01T12:34:56Z", "absolute_url": "https://job-boards.greenhouse.io/paypay/jobs/123", "location": { "name": "Tokyo" } }\n';
    const connector = new GreenhouseConnector(async () => new Response(exact, {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as never);
    const record = await connector.fetchRecord({
      sourceInstanceId: source.id,
      stableKey: "123",
      externalId: "123",
      canonicalUrl: "https://job-boards.greenhouse.io/paypay/jobs/123",
    }, AbortSignal.timeout(1_000));
    expect(new TextDecoder().decode(record.raw)).toBe(exact);
    expect(record.exactRecordResponse).toBe(true);
  });
});
