import { describe, expect, it } from "vitest";
import type { SourceInstanceRef } from "../../contracts/src/index.js";
import { collectSnapshot } from "../../domain/src/snapshot-orchestrator.js";
import { HrmosConnector, parseHrmosCollection } from "./hrmos-connector.js";

const source: SourceInstanceRef = {
  id: "11111111-1111-4111-8111-111111111111",
  sourceKind: "hrmos",
  tenantKey: "fixture-company",
  baseUrl: "https://hrmos.co",
};

const listFixture = `<section id="jsi-joblist"><h2 class="pg-count">全 2 件中 2 件 を表示しています</h2><ul>
  <li><a href="https://hrmos.co/pages/fixture-company/jobs/engineering"><h2>Engineer</h2></a></li>
  <li><a href="/pages/fixture-company/jobs/hr"><h2>HR</h2></a></li>
</ul></section><input id="jsi-total-count" value="2"><nav class="pg-pagenation"><ol><li class="current">1</li></ol></nav>`;

describe("HRMOS connector", () => {
  it("parses stable record identities and provider total", () => {
    expect(parseHrmosCollection(new TextEncoder().encode(listFixture), source.tenantKey, 1)).toEqual({
      identities: [
        { externalId: "engineering", url: "https://hrmos.co/pages/fixture-company/jobs/engineering" },
        { externalId: "hr", url: "https://hrmos.co/pages/fixture-company/jobs/hr" },
      ],
      providerTotal: 2,
    });
  });

  it("retrieves exact detail bodies before producing an authoritative snapshot", async () => {
    const connector = fixtureConnector();
    const snapshot = await collectSnapshot(connector, context());
    expect(snapshot.kind).toBe("authoritative");
    expect(snapshot.jobs.map((job) => job.identity.stableKey)).toEqual(["engineering", "hr"]);
    expect(new TextDecoder().decode(snapshot.jobs[0]?.raw)).toContain("Engineer exact detail");
  });

  it("makes the snapshot partial when any detail fetch is interrupted", async () => {
    const connector = fixtureConnector("hr");
    const snapshot = await collectSnapshot(connector, context());
    expect(snapshot.kind).toBe("partial");
    expect(snapshot.validation.allPagesCompleted).toBe(false);
    expect(snapshot.validation.parseErrors.join(" ")).toContain("500");
    expect(snapshot.jobs).toHaveLength(0);
  });

  it("rejects a non-HRMOS collection host before fetching", async () => {
    let fetched = false;
    const connector = new HrmosConnector(async () => { fetched = true; return response(listFixture); });
    const snapshot = await collectSnapshot(connector, {
      ...context(),
      source: { ...source, baseUrl: "https://internal.example" },
    });
    expect(snapshot.kind).toBe("partial");
    expect(snapshot.validation.parseErrors.join(" ")).toContain("only permits");
    expect(fetched).toBe(false);
  });
});

function fixtureConnector(failingId?: string): HrmosConnector {
  return new HrmosConnector(async (input) => {
    const url = String(input);
    if (url.endsWith("/pages/fixture-company/jobs")) return response(listFixture);
    const id = url.split("/").at(-1);
    if (id === failingId) return new Response("failure", { status: 500 });
    return response(`<html><script type="application/ld+json">{"@type":"JobPosting"}</script><body>${id === "hr" ? "HR" : "Engineer"} exact detail</body></html>`);
  });
}

function response(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

function context() {
  return {
    source,
    previousActiveStableKeys: new Set<string>(),
    policy: { allowsAuthoritativeSnapshot: true, minimumPreviousActive: 5, maximumMissingRatio: 0.5, maximumMissingAbsolute: 25 },
    now: () => new Date("2026-07-13T00:00:00.000Z"),
    signal: AbortSignal.timeout(1_000),
  };
}
