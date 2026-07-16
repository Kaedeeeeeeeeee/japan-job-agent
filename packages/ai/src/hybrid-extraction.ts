import type { AiFactCandidate, EnrichableJobField, EvidenceCandidate } from "../../contracts/src/index.js";
import type {
  CompensationFact,
  ExperienceRequirementFact,
  LanguageFact,
  LocationFact,
  ParsedJob,
  SkillFact,
} from "../../parser/src/deterministic-job-parser.js";
import {
  normalizeCompensationText,
  normalizeEmploymentValues,
  normalizeLanguageFacts,
  normalizeLocationText,
  normalizeSkillFacts,
} from "../../parser/src/job-normalizers.js";

export interface HybridMergeResult {
  structured: ParsedJob;
  evidence: EvidenceCandidate[];
  changedFields: EnrichableJobField[];
}

export function mergeAiCandidates(
  base: ParsedJob,
  candidates: readonly AiFactCandidate[],
  sourceUrl: string,
  promptVersion: string,
  modelKey: string,
): HybridMergeResult {
  const structured = clone(base);
  const evidence: EvidenceCandidate[] = [];
  const changedFields: EnrichableJobField[] = [];
  const grouped = new Map<EnrichableJobField, AiFactCandidate[]>();
  for (const candidate of candidates) grouped.set(candidate.field, [...(grouped.get(candidate.field) ?? []), candidate]);
  for (const [field, fieldCandidates] of grouped) {
    const current = structured[field];
    if (!isFact(current) || current.state !== "unknown") continue;
    const values = normalizedValues(field, fieldCandidates);
    if (values.length === 0) continue;
    (structured as Record<string, unknown>)[field] = {
      state: field === "compensation" && values.length > 1 ? "conflicting" : "known",
      values,
    };
    changedFields.push(field);
    for (const candidate of fieldCandidates.slice(0, values.length)) {
      evidence.push({
        fieldPath: field,
        quotedText: candidate.quote,
        sourceUrl,
        locator: { kind: "ai_evidence_candidate", sectionId: candidate.sectionId,
          promptVersion, modelKey, requirementKind: candidate.requirementKind },
      });
    }
  }
  return { structured, evidence, changedFields };
}

function normalizedValues(field: EnrichableJobField, candidates: readonly AiFactCandidate[]): unknown[] {
  const values: unknown[] = [];
  for (const candidate of candidates) {
    const input = `${candidate.rawValue}\n${candidate.quote}`;
    if (field === "employmentTypes") {
      values.push(...normalizeEmploymentValues(input));
      continue;
    }
    if (field === "locations") {
      const value = normalizeLocationText(input);
      if (value !== null) values.push(value satisfies LocationFact);
      continue;
    }
    if (field === "compensation") {
      values.push(...(normalizeCompensationText(input) satisfies CompensationFact[]));
      continue;
    }
    if (field === "languages") {
      values.push(...(normalizeLanguageFacts(input, candidate.requirementKind) satisfies LanguageFact[]));
      continue;
    }
    if (field === "skills") {
      const known = normalizeSkillFacts(input, candidate.requirementKind) satisfies SkillFact[];
      if (known.length > 0) {
        values.push(...known);
        continue;
      }
      const normalized = normalizedSkillCandidate(candidate);
      if (normalized !== null) values.push(normalized);
      continue;
    }
    values.push(...normalizeExperience(input, candidate.requirementKind));
  }
  return unique(values);
}

function normalizedSkillCandidate(candidate: AiFactCandidate): SkillFact | null {
  const proposed = typeof candidate.normalizedCandidate === "string" ? candidate.normalizedCandidate
    : isRecord(candidate.normalizedCandidate) && typeof candidate.normalizedCandidate.normalizedSkill === "string"
      ? candidate.normalizedCandidate.normalizedSkill : candidate.rawValue;
  const normalizedSkill = proposed.trim().toLocaleLowerCase("en-US");
  if (normalizedSkill.length < 1 || normalizedSkill.length > 80 || /[\r\n<>]/.test(normalizedSkill)) return null;
  return { normalizedSkill, originalText: candidate.rawValue, requirementKind: candidate.requirementKind };
}

function normalizeExperience(input: string, requirementKind: AiFactCandidate["requirementKind"]): ExperienceRequirementFact[] {
  const match = /(?:実務経験|開発経験|業務経験|エンジニア経験)?[^。\n]{0,24}?(\d{1,2})\s*年(?:以上|超)|(?:at\s+least\s+)?(\d{1,2})\+?\s+years?/i.exec(input);
  const years = Number(match?.[1] ?? match?.[2]);
  if (!Number.isInteger(years) || years < 1 || years > 30) return [];
  return [{ minimumYears: years, originalText: match?.[0] ?? input,
    requirementKind: requirementKind === "preferred" ? "preferred" : "required" }];
}

function isFact(value: unknown): value is { state: string; values: unknown[] } {
  return value !== null && typeof value === "object" && "state" in value && "values" in value && Array.isArray(value.values);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unique(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = stableJson(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
