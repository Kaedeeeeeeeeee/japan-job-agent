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
    expect(parseRecords("airwork", bytes('<a href="/recruit/acme/123/">A</a><a href="/recruit/acme/policy/">No</a>'), "acme"))
      .toEqual([{ externalId: "123", url: "https://arwrk.net/recruit/acme/123/" }]);
    expect(parseRecords("engage", bytes('<a href="/acme/work_456/?via=1">A</a>'), "acme"))
      .toEqual([{ externalId: "456", url: "https://en-gage.net/acme/work_456/" }]);
    expect(parseRecords("talentio", bytes('<div data-props="{&quot;publishedUrl&quot;:&quot;https://open.talentio.com/r/1/c/acme/pages/789&quot;}"></div>'), "acme"))
      .toEqual([{ externalId: "789", url: "https://open.talentio.com/r/1/c/acme/pages/789" }]);
  });

  it.each([
    ["airwork", "https://arwrk.net/recruit/acme", '<a href="/recruit/acme/123/">A</a>', "/123/"],
    ["engage", "https://en-gage.net/acme/", '<a href="/acme/work_456/">A</a>', "work_456/"],
    ["talentio", "https://open.talentio.com/r/1/c/acme/homes/1", '<a href="/r/1/c/acme/pages/789">A</a>', "/789"],
  ] as const)("only finalizes a complete %s collection after detail fetches", async (kind, baseUrl, listing, detailSuffix) => {
    let details = 0;
    const connector = new PublicCareerConnector(kind, async (input) => {
      if (kind === "talentio" && String(input) === "https://open.talentio.com/sitemap.xml") {
        return response('<?xml version="1.0"?><urlset><url><loc>https://open.talentio.com/r/1/c/acme/pages/789</loc></url></urlset>');
      }
      if (String(input).endsWith(detailSuffix)) {
        details += 1;
        return response("<html><h1>Engineer</h1><main>Current official role with enough deterministic detail text for parsing.</main></html>");
      }
      return response(listing);
    });
    const source: SourceInstanceRef = { id: "11111111-1111-4111-8111-111111111111", sourceKind: kind, tenantKey: "acme", baseUrl };
    const snapshot = await collectSnapshot(connector, { source, previousActiveStableKeys: new Set(),
      policy: { allowsAuthoritativeSnapshot: true, minimumPreviousActive: 5, maximumMissingRatio: 0.5, maximumMissingAbsolute: 25 },
      now: () => new Date("2026-07-14T00:00:00Z"), signal: AbortSignal.timeout(1_000) });
    expect(snapshot).toMatchObject({ kind: "authoritative", providerTotal: 1 });
    expect(details).toBe(1);
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
