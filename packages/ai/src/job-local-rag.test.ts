import { describe, expect, it } from "vitest";
import type { AiFactCandidate } from "../../contracts/src/index.js";
import { rankSections, validateFactCandidates, vectorLiteral } from "./job-local-rag.js";

const sections = [
  { id: crypto.randomUUID(), canonical_document_id: "doc", section_kind: "responsibilities", heading: "仕事内容", section_text: "API開発", ordinal: 0 },
  { id: crypto.randomUUID(), canonical_document_id: "doc", section_kind: "location", heading: "勤務地", section_text: "新潟県燕市", ordinal: 1 },
  { id: crypto.randomUUID(), canonical_document_id: "doc", section_kind: "compensation", heading: "給与", section_text: "月給22万円〜25万円", ordinal: 2 },
];

describe("job-local RAG", () => {
  it("ranks explicit structured sections before keyword-only sections", () => {
    expect(rankSections(sections, "locations").map((section) => section.section_kind)).toEqual(["location"]);
    expect(rankSections(sections, "compensation")[0]?.section_kind).toBe("compensation");
  });

  it("accepts exact quotes from the retrieved section", () => {
    const location = sections[1]!;
    const candidate: AiFactCandidate = { field: "locations", quote: "新潟県燕市", sectionId: location.id,
      rawValue: "新潟県燕市", normalizedCandidate: "新潟県燕市", requirementKind: "mentioned" };
    expect(validateFactCandidates([candidate], [{ id: location.id, kind: "location", heading: "勤務地", text: location.section_text }], ["locations"]))
      .toEqual([candidate]);
  });

  it("rejects forged quotes, non-requested fields, and cross-job section IDs", () => {
    const location = sections[1]!;
    const base: AiFactCandidate = { field: "locations", quote: "東京都", sectionId: location.id,
      rawValue: "東京都", normalizedCandidate: "東京都", requirementKind: "mentioned" };
    const retrieved = [{ id: location.id, kind: "location", heading: "勤務地", text: location.section_text }];
    expect(() => validateFactCandidates([base], retrieved, ["locations"])).toThrow("quote");
    expect(() => validateFactCandidates([{ ...base, quote: "新潟県燕市", rawValue: "新潟県燕市", sectionId: crypto.randomUUID() }], retrieved, ["locations"]))
      .toThrow("outside");
    expect(() => validateFactCandidates([{ ...base, field: "skills", quote: "新潟県燕市", rawValue: "新潟県燕市" }], retrieved, ["locations"]))
      .toThrow("non-requested");
  });

  it("serializes only finite non-empty vectors", () => {
    expect(vectorLiteral([1, 0.5])).toBe("[1,0.5]");
    expect(() => vectorLiteral([])).toThrow("Invalid");
    expect(() => vectorLiteral([Number.NaN])).toThrow("Invalid");
  });
});
