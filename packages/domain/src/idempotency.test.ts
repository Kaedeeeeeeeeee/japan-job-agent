import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { JobParser, ParserContext, SourceJobVersion } from "../../contracts/src/index.js";
import { VersionStore } from "./idempotency.js";

const version: SourceJobVersion = {
  id: randomUUID(),
  sourceJobRecordId: randomUUID(),
  rawHash: "a".repeat(64),
  contentHash: "b".repeat(64),
  canonicalizationVersion: "html-v1",
  raw: new TextEncoder().encode("fixture"),
  sourceUrl: "https://example.com/job",
  fetchedAt: "2026-07-13T00:00:00.000Z",
};
const context: ParserContext = {
  source: {
    id: randomUUID(),
    sourceKind: "manual",
    tenantKey: "fixture",
    baseUrl: "https://example.com",
  },
  localeHints: ["ja-JP"],
};

function parser(parserVersion: string): JobParser {
  return {
    parserKey: "fixture",
    parserVersion,
    schemaVersion: "job-v1",
    async parse() {
      return { status: "succeeded", structured: { parserVersion }, evidence: [], errors: [] };
    },
  };
}

describe("raw and extraction idempotency", () => {
  it("deduplicates unchanged raw bytes independently from parser replay", async () => {
    const store = new VersionStore();
    expect(store.putRaw(version)).toBe(version);
    expect(store.putRaw({ ...version, id: randomUUID() })).toBe(version);
    const v1 = await store.extract(version, parser("1"), context);
    const v2 = await store.extract(version, parser("2"), context);
    expect(v2.id).not.toBe(v1.id);
    expect(await store.extract(version, parser("2"), context)).toBe(v2);
    expect(store.rawVersions).toHaveLength(1);
    expect(store.extractions).toHaveLength(2);
  });
});

