import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface Seed { key: string; pool: string; auditState: string; sourceKind?: string; sourceUrl?: string; currentJobCount?: number }

describe("company seed audit contract", () => {
  const seeds = JSON.parse(readFileSync(path.resolve("config/company-seeds.json"), "utf8")) as Seed[];
  it("tracks all 16 unique seeds and at least 10 verified official relationships", () => {
    expect(seeds).toHaveLength(16);
    expect(new Set(seeds.map((seed) => seed.key)).size).toBe(16);
    expect(seeds.filter((seed) => seed.auditState === "verified")).toHaveLength(11);
  });
  it("requires verified seeds to have a source URL and current jobs", () => {
    for (const seed of seeds.filter((value) => value.auditState === "verified")) {
      expect(seed.sourceKind).toMatch(/greenhouse|schema_org|manual/);
      expect(seed.sourceUrl).toMatch(/^https:\/\//);
      expect(seed.currentJobCount).toBeGreaterThan(0);
    }
  });
});
