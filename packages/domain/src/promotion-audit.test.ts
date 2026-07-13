import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface PromotionRow { externalKey: string; displayName: string; status: string; currentJobCount: number; detectedSources: unknown }
interface PromotionAudit { totalCompanies: number; linkedCompanies: number; statusCounts: Record<string, number>;
  sourceCounts: Array<{ source_kind: string; sources: number; jobs: number }>; companies: PromotionRow[] }

describe("JETRO OFP promotion audit snapshot", () => {
  const audit = JSON.parse(readFileSync(path.resolve("config/jetro-ofp-promotion-audit-2026-07-14.json"), "utf8")) as PromotionAudit;

  it("accounts for all 374 companies with one terminal state and formal Company link", () => {
    expect(audit.totalCompanies).toBe(374);
    expect(audit.linkedCompanies).toBe(374);
    expect(audit.companies).toHaveLength(374);
    expect(new Set(audit.companies.map((row) => row.externalKey)).size).toBe(374);
    expect(Object.values(audit.statusCounts).reduce((sum, count) => sum + count, 0)).toBe(374);
  });

  it("only calls companies active when current official jobs were synchronized", () => {
    const active = audit.companies.filter((row) => row.status === "promoted_active");
    expect(active).toHaveLength(10);
    expect(active.every((row) => row.currentJobCount > 0)).toBe(true);
    expect(audit.sourceCounts.reduce((sum, row) => sum + row.jobs, 0)).toBe(139);
  });

  it("contains no contact-person fields or obvious phone/email payloads", () => {
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toMatch(/contactPerson|phoneNumber|emailAddress/i);
    expect(serialized).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
  });
});
