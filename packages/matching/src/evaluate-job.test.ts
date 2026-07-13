import { describe, expect, it } from "vitest";
import type { SafeProfile } from "../../profile/src/build-profile.js";
import { evaluateJob, type CanonicalJobForMatch } from "./evaluate-job.js";

const profile = {
  schemaVersion: "profile-v1", targetChannels: ["new_grad_2027"], rolePriorities: [], locations: {},
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
    evidenceByField: { employmentTypes: ["e1"], locations: ["e2"], skills: ["e3"], languages: ["e4"] },
    ...overrides,
  };
}

describe("deterministic Profile matching", () => {
  it("keeps visa and salary unknown eligible while returning evidence-backed matches", () => {
    const result = evaluateJob(profile, job());
    expect(result.eligible).toBe(true);
    expect(result.unknowns.map((item) => item.field)).toEqual(expect.arrayContaining(["visaSupport", "compensation"]));
    expect(result.matched.find((item) => item.field === "skills")?.evidenceIds).toEqual(["e3"]);
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
});

