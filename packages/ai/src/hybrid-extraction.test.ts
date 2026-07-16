import { describe, expect, it } from "vitest";
import type { AiFactCandidate } from "../../contracts/src/index.js";
import type { ParsedJob } from "../../parser/src/deterministic-job-parser.js";
import { mergeAiCandidates } from "./hybrid-extraction.js";

function base(): ParsedJob {
  return {
    title: "事務", descriptionText: "",
    employmentTypes: { state: "known", values: ["permanent"] },
    locations: { state: "unknown", values: [], unknownReason: "not_parsed" },
    compensation: { state: "unknown", values: [], unknownReason: "unsupported_format" },
    skills: { state: "unknown", values: [], unknownReason: "not_parsed" },
    languages: { state: "unknown", values: [], unknownReason: "not_mentioned" },
    experienceRequirements: { state: "unknown", values: [], unknownReason: "not_mentioned" },
    visaSupport: { state: "unknown", values: [], unknownReason: "not_mentioned" },
    jobDates: {
      published: { state: "unknown", values: [], unknownReason: "not_mentioned" },
      sourceUpdated: { state: "unknown", values: [], unknownReason: "not_mentioned" },
      validThrough: { state: "unknown", values: [], unknownReason: "not_mentioned" },
    },
  };
}

function candidate(overrides: Partial<AiFactCandidate>): AiFactCandidate {
  return { field: "locations", quote: "新潟県燕市", sectionId: crypto.randomUUID(), rawValue: "新潟県燕市",
    normalizedCandidate: "新潟県燕市", requirementKind: "mentioned", ...overrides };
}

describe("Hybrid Extraction merge", () => {
  it("normalizes AI-located address and monthly salary deterministically", () => {
    const result = mergeAiCandidates(base(), [candidate({}), candidate({ field: "compensation", quote: "月給 22万円 〜 25万円",
      rawValue: "月給 22万円 〜 25万円", normalizedCandidate: { minimum: 220000, maximum: 250000 } })],
    "https://example.com", "prompt-v1", "model-v1");
    expect(result.structured.locations).toMatchObject({ state: "known", values: [{ countryCode: "JP", prefecture: "新潟県", city: "燕市" }] });
    expect(result.structured.compensation).toMatchObject({ state: "known", values: [{ period: "month", minimumAmount: 220000, maximumAmount: 250000 }] });
    expect(result.evidence.every((item) => item.locator.sectionId !== undefined)).toBe(true);
  });

  it("never overwrites a deterministic known field", () => {
    const result = mergeAiCandidates(base(), [candidate({ field: "employmentTypes", quote: "契約社員", rawValue: "契約社員",
      normalizedCandidate: "fixed_term" })], "https://example.com", "prompt-v1", "model-v1");
    expect(result.structured.employmentTypes).toEqual({ state: "known", values: ["permanent"] });
    expect(result.changedFields).not.toContain("employmentTypes");
  });
});
