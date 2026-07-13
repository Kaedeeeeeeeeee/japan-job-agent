import { describe, expect, it } from "vitest";
import type { SourceInstanceRef } from "../../contracts/src/index.js";
import { collectSnapshot } from "../../domain/src/snapshot-orchestrator.js";
import { PublicCareerConnector, parseRecords } from "./public-career-connector.js";

describe("public career connectors", () => {
  it("parses HERP and Jobcan stable identities", () => {
    expect(parseRecords("herp", bytes('<a href="/v1/acme/job-a">A</a><a href="/v1/other/no">No</a>'), "acme"))
      .toEqual([{ externalId: "job-a", url: "https://herp.careers/v1/acme/job-a" }]);
    expect(parseRecords("jobcan", bytes('<a href="/acme/job_offers/42?hide=false">A</a>'), "acme"))
      .toEqual([{ externalId: "42", url: "https://recruit.jobcan.jp/acme/job_offers/42" }]);
  });

  it("only finalizes HERP after exact detail bodies are fetched", async () => {
    const connector = new PublicCareerConnector("herp", async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/acme")) return response('<a href="/v1/acme/job-a">募集中</a>');
      return response('<script type="application/ld+json">{"@type":"JobPosting","title":"Engineer"}</script>');
    });
    const source: SourceInstanceRef = { id: "11111111-1111-4111-8111-111111111111", sourceKind: "herp", tenantKey: "acme", baseUrl: "https://herp.careers/v1/acme" };
    const snapshot = await collectSnapshot(connector, { source, previousActiveStableKeys: new Set(),
      policy: { allowsAuthoritativeSnapshot: true, minimumPreviousActive: 5, maximumMissingRatio: 0.5, maximumMissingAbsolute: 25 },
      now: () => new Date("2026-07-14T00:00:00Z"), signal: AbortSignal.timeout(1_000) });
    expect(snapshot).toMatchObject({ kind: "authoritative", providerTotal: 1 });
    expect(new TextDecoder().decode(snapshot.jobs[0]?.raw)).toContain("JobPosting");
  });

  it("rejects cross-host redirects", async () => {
    const connector = new PublicCareerConnector("herp", async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1" } }));
    const source: SourceInstanceRef = { id: "11111111-1111-4111-8111-111111111111", sourceKind: "herp", tenantKey: "acme", baseUrl: "https://herp.careers/v1/acme" };
    const result = await collectSnapshot(connector, { source, previousActiveStableKeys: new Set(),
      policy: { allowsAuthoritativeSnapshot: true, minimumPreviousActive: 5, maximumMissingRatio: 0.5, maximumMissingAbsolute: 25 },
      now: () => new Date(), signal: AbortSignal.timeout(1_000) });
    expect(result.kind).toBe("partial");
    expect(result.validation.parseErrors.join(" ")).toContain("only permits");
  });
});

function bytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function response(value: string): Response { return new Response(value, { status: 200, headers: { "content-type": "text/html" } }); }
