import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface CorpusAudit {
  activeCanonicalJobs: number; eligibleForPrimaryProfile: number; hardRejected: number;
  sourceCounts: Array<{ source_kind: string; sources: number; jobs: number }>;
  parser: { version: string; succeeded: number }; evidence: { non_unknown_facts: number; missing_evidence: number };
  greenhouse: Array<{ tenantKey: string; activeJobCount: number; japanJobCount: number; status: string }>;
}

describe("expanded verified job corpus snapshot", () => {
  const audit = JSON.parse(readFileSync(path.resolve("config/job-corpus-audit-2026-07-14.json"), "utf8")) as CorpusAudit;

  it("accounts for every active Canonical Job and Profile decision", () => {
    expect(audit.activeCanonicalJobs).toBe(660);
    expect(audit.eligibleForPrimaryProfile).toBe(457);
    expect(audit.eligibleForPrimaryProfile + audit.hardRejected).toBe(audit.activeCanonicalJobs);
    expect(audit.sourceCounts.reduce((sum, row) => sum + row.jobs, 0)).toBe(audit.activeCanonicalJobs);
  });

  it("keeps every current extraction and non-unknown high-risk fact evidenced", () => {
    expect(audit.parser).toEqual({ version: "1.6.0", succeeded: 660 });
    expect(audit.evidence.non_unknown_facts).toBeGreaterThan(1_000);
    expect(audit.evidence.missing_evidence).toBe(0);
  });

  it("records seven currently verified Greenhouse tenants with Japan jobs", () => {
    expect(audit.greenhouse).toHaveLength(7);
    expect(audit.greenhouse.every((row) => row.status === "verified" && row.japanJobCount > 0)).toBe(true);
    expect(audit.greenhouse.map((row) => row.tenantKey)).toEqual(expect.arrayContaining([
      "paypay", "paypaycard", "paypaysec", "appier", "knowbe4", "marqvision", "glance",
    ]));
  });
});
