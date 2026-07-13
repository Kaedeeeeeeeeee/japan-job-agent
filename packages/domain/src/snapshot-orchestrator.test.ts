import { describe, expect, it } from "vitest";
import type {
  CollectionPage,
  CollectionPageRequest,
  DiscoveredJob,
  SourceConnector,
  SourceInstanceRef,
  SourceJobIdentity,
} from "../../contracts/src/index.js";
import { collectSnapshot } from "./snapshot-orchestrator.js";

const source: SourceInstanceRef = {
  id: "11111111-1111-4111-8111-111111111111",
  sourceKind: "greenhouse",
  tenantKey: "fixture",
  baseUrl: "https://boards-api.greenhouse.io/v1/boards/fixture",
};

function job(key: string): DiscoveredJob {
  const identity: SourceJobIdentity = {
    sourceInstanceId: source.id,
    stableKey: key,
    externalId: key,
    canonicalUrl: `https://example.com/jobs/${key}`,
  };
  return {
    identity,
    recordUrl: identity.canonicalUrl,
    raw: new TextEncoder().encode(key),
    response: {
      requestedUrl: identity.canonicalUrl,
      finalUrl: identity.canonicalUrl,
      status: 200,
      fetchedAt: "2026-07-13T00:00:00.000Z",
      contentType: "application/json",
      etag: null,
      lastModified: null,
      requestId: null,
    },
  };
}

class FixtureConnector implements SourceConnector {
  readonly kind = "greenhouse" as const;
  private request = 0;

  constructor(private readonly pages: readonly (CollectionPage | Error)[]) {}

  async fetchCollectionPage(_request: CollectionPageRequest): Promise<CollectionPage> {
    const page = this.pages[this.request++];
    if (page instanceof Error) throw page;
    if (page === undefined) throw new Error("missing fixture page");
    return page;
  }

  async fetchRecord(): Promise<DiscoveredJob> {
    throw new Error("not used");
  }
}

function page(jobs: DiscoveredJob[], isLastPage: boolean, nextCursor?: string): CollectionPage {
  const result: CollectionPage = {
    jobs,
    isLastPage,
    providerTotal: 2,
    response: jobs[0]?.response ?? job("response").response,
  };
  if (nextCursor !== undefined) result.nextCursor = nextCursor;
  return result;
}

const context = {
  source,
  previousActiveStableKeys: new Set<string>(),
  policy: { allowsAuthoritativeSnapshot: true, minimumPreviousActive: 5, maximumMissingRatio: 0.5, maximumMissingAbsolute: 25 },
  now: () => new Date("2026-07-13T00:00:00.000Z"),
  signal: AbortSignal.timeout(1_000),
};

describe("snapshot orchestration", () => {
  it("only finalizes authoritative after every page completes and total matches", async () => {
    const result = await collectSnapshot(
      new FixtureConnector([page([job("1")], false, "next"), page([job("2")], true)]),
      context,
    );
    expect(result.kind).toBe("authoritative");
    expect(result.pageCount).toBe(2);
    expect(result.jobs).toHaveLength(2);
  });

  it("downgrades an interrupted pagination to partial", async () => {
    const result = await collectSnapshot(
      new FixtureConnector([page([job("1")], false, "next"), new Error("page 2 timed out")]),
      context,
    );
    expect(result.kind).toBe("partial");
    expect(result.validation.allPagesCompleted).toBe(false);
    expect(result.validation.parseErrors).toContain("page 2 timed out");
  });

  it("trips on an abnormal empty collection and never calls it authoritative", async () => {
    const previous = new Set(Array.from({ length: 5 }, (_, index) => String(index)));
    const empty: CollectionPage = { ...page([], true), providerTotal: 0 };
    const result = await collectSnapshot(new FixtureConnector([empty]), { ...context, previousActiveStableKeys: previous });
    expect(result.kind).toBe("partial");
    expect(result.validation.circuitBreakerReasons).toContain("unexpected_zero");
  });

  it("trips on a missing ratio over 50 percent", async () => {
    const previous = new Set(["1", "2", "3", "4"]);
    const result = await collectSnapshot(
      new FixtureConnector([{ ...page([job("1")], true), providerTotal: 1 }]),
      { ...context, previousActiveStableKeys: previous },
    );
    expect(result.kind).toBe("partial");
    expect(result.validation.circuitBreakerReasons).toContain("missing_ratio_exceeded");
  });

  it("trips when one snapshot loses more than 25 jobs", async () => {
    const previous = new Set(Array.from({ length: 30 }, (_, index) => String(index)));
    const current = [job("0"), job("1"), job("2"), job("3")];
    const result = await collectSnapshot(
      new FixtureConnector([{ ...page(current, true), providerTotal: current.length }]),
      { ...context, previousActiveStableKeys: previous },
    );
    expect(result.kind).toBe("partial");
    expect(result.validation.circuitBreakerReasons).toContain("missing_absolute_exceeded");
  });

  it("cannot be authoritative when source policy forbids complete snapshots", async () => {
    const result = await collectSnapshot(
      new FixtureConnector([page([job("1"), job("2")], true)]),
      { ...context, policy: { ...context.policy, allowsAuthoritativeSnapshot: false } },
    );
    expect(result.kind).toBe("partial");
  });
});
