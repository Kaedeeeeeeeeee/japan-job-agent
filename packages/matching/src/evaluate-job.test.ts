import { describe, expect, it } from "vitest";
import type { SafeProfile } from "../../profile/src/build-profile.js";
import { evaluateJob, type CanonicalJobForMatch } from "./evaluate-job.js";

const profile = {
  schemaVersion: "profile-v1", targetChannels: ["new_grad_2027"],
  rolePriorities: [{ group: "product_web_ai_engineering", weight: 1 }], locations: {},
  employment: { preferred: ["permanent"], needsConfirmation: ["fixed_term"], excluded: ["dispatch", "independent_contractor", "part_time", "ses_on_site"] },
  languages: [{ code: "ja", level: "JLPT N1" }, { code: "zh", level: "native" }], visa: {}, compensation: {},
  normalizedSkills: ["TypeScript", "React"], experienceSignals: ["web_product"],
  piiPolicy: { directPiiStored: false, extractionMode: "allowlist_only" },
} satisfies SafeProfile;

function job(overrides: Partial<CanonicalJobForMatch> = {}): CanonicalJobForMatch {
  return {
    canonicalJobId: "job", canonicalJobVersionId: "version", lifecycleState: "active", verifiedOfficialSource: true,
    title: "Web Engineer", applicationUrl: "https://example.com/apply",
    structured: {
      employmentTypes: { state: "known", values: ["permanent"] },
      locations: { state: "known", values: [{ countryCode: "JP", prefecture: "東京都", addressText: "Tokyo" }] },
      skills: { state: "known", values: [{ normalizedSkill: "typescript", requirementKind: "required" }] },
      languages: { state: "known", values: [{ languageCode: "ja", minimumLevel: "N1", requirementKind: "required" }] },
      visaSupport: { state: "unknown", values: [] }, compensation: { state: "unknown", values: [] },
    },
    fetchedAt: new Date().toISOString(),
    evidenceByField: { employmentTypes: ["e1"], locations: ["e2"], skills: ["e3"], languages: ["e4"], title: ["e5"], sourceVerification: ["e6"] },
    ...overrides,
  };
}

describe("deterministic Profile matching", () => {
  it("keeps visa and salary unknown eligible while returning evidence-backed matches", () => {
    const result = evaluateJob(profile, job());
    expect(result.eligible).toBe(true);
    expect(result.unknowns.map((item) => item.field)).toEqual(expect.arrayContaining(["visaSupport", "compensation"]));
    expect(result.matched.find((item) => item.field === "skills")?.evidenceIds).toEqual(["e3"]);
    expect(result.scoreBreakdown.map((item) => item.maximum)).toEqual([25, 25, 15, 10, 10, 5, 5, 5]);
    expect(result.scoreBreakdown.reduce((sum, item) => sum + item.maximum, 0)).toBe(100);
    expect(result.score).toBeGreaterThan(0);
  });

  it("hard rejects only explicit excluded employment and location conflicts", () => {
    const result = evaluateJob(profile, job({ structured: {
      employmentTypes: { state: "known", values: ["dispatch"] },
      locations: { state: "known", values: [{ countryCode: "US", addressText: "New York" }] },
    } }));
    expect(result.eligible).toBe(false);
    expect(result.hardRejectReasons).toEqual(expect.arrayContaining(["explicitly_excluded_employment", "explicit_location_conflict"]));
  });

  it("rejects inactive or unverified sources before preferences", () => {
    const result = evaluateJob(profile, job({ lifecycleState: "closed", verifiedOfficialSource: false }));
    expect(result.hardRejectReasons).toEqual(expect.arrayContaining(["job_not_active", "no_verified_official_source"]));
  });

  it("keeps every factual match and gap evidence-backed", () => {
    const result = evaluateJob(profile, job());
    expect([...result.matched, ...result.gaps].every((item) => item.evidenceIds.length > 0)).toBe(true);
  });

  it("ranks office roles for an office profile without giving engineering titles a fallback role score", () => {
    const officeProfile = { ...profile, rolePriorities: [
      { group: "office_administration", weight: 1 },
      { group: "human_resources_recruiting", weight: 0.8 },
    ] };
    const office = evaluateJob(officeProfile, job({ title: "一般事務" }));
    const humanResources = evaluateJob(officeProfile, job({ title: "人事アシスタント" }));
    const engineering = evaluateJob(officeProfile, job({ title: "Backend Engineer" }));
    expect(office.scoreBreakdown.find((part) => part.key === "role_direction")?.score).toBe(25);
    expect(humanResources.scoreBreakdown.find((part) => part.key === "role_direction")?.score).toBe(20);
    expect(engineering.scoreBreakdown.find((part) => part.key === "role_direction")?.score).toBe(0);
  });

  it("uses explicit title employment when structured employment is missing", () => {
    const unknownEmployment = { ...job().structured, employmentTypes: { state: "unknown", values: [] } };
    const partTime = evaluateJob(profile, job({ title: "【アルバイト・パート】一般事務", structured: unknownEmployment }));
    const partnerSales = evaluateJob(profile, job({ title: "パートナーセールス", structured: unknownEmployment }));
    expect(partTime.hardRejectReasons).toContain("explicitly_excluded_employment");
    expect(partTime.gaps.find((item) => item.field === "employmentTypes")?.evidenceIds).toContain("e5");
    expect(partnerSales.hardRejectReasons).not.toContain("explicitly_excluded_employment");
  });
});
