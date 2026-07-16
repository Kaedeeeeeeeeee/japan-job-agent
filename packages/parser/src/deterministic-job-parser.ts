import type {
  CanonicalDocument,
  CanonicalDocumentSection,
  EvidenceCandidate,
  ExtractionCandidate,
  FactUnknownReason,
  JobDateValue,
  JobParser,
  ParserContext,
  SourceJobVersion,
} from "../../contracts/src/index.js";
import { buildCanonicalDocument } from "../../canonical-document/src/canonical-document.js";
import {
  normalizeCompensationText,
  normalizeEmploymentValues,
  normalizeLanguageFacts,
  normalizeLocationText,
  normalizeSkillFacts,
} from "./job-normalizers.js";

export interface Fact<T> {
  state: "known" | "unknown" | "conflicting";
  values: T[];
  unknownReason?: FactUnknownReason;
}

export interface LocationFact {
  countryCode: string | null;
  prefecture: string | null;
  city: string | null;
  addressText: string;
  remoteScope: string | null;
}

export interface LanguageFact {
  languageCode: string;
  minimumLevel: string | null;
  requirementKind: "required" | "preferred" | "mentioned";
}

export interface SkillFact {
  normalizedSkill: string;
  originalText: string;
  requirementKind: "required" | "preferred" | "mentioned";
}

export interface CompensationFact {
  compensationKind: "base" | "total" | "trial" | "bonus" | "other";
  currency: string;
  period: "hour" | "day" | "month" | "year";
  minimumAmount: number | null;
  maximumAmount: number | null;
  isCalculated: boolean;
}

export interface ExperienceRequirementFact {
  minimumYears: number;
  originalText: string;
  requirementKind: "required" | "preferred";
}

export interface ParsedJob extends Record<string, unknown> {
  title: string;
  descriptionText: string;
  employmentTypes: Fact<string>;
  visaSupport: Fact<boolean>;
  locations: Fact<LocationFact>;
  languages: Fact<LanguageFact>;
  skills: Fact<SkillFact>;
  compensation: Fact<CompensationFact>;
  experienceRequirements: Fact<ExperienceRequirementFact>;
  jobDates: {
    published: Fact<JobDateValue>;
    sourceUpdated: Fact<JobDateValue>;
    validThrough: Fact<JobDateValue>;
  };
}

export class DeterministicJobParser implements JobParser {
  readonly parserKey = "deterministic-job";
  readonly parserVersion = "1.8.3";
  readonly schemaVersion = "job-v3";

  async parse(version: SourceJobVersion, context: ParserContext): Promise<ExtractionCandidate> {
    try {
      return this.parseCanonical(version, context, buildCanonicalDocument(version, context));
    } catch (error) {
      return failed(error);
    }
  }

  async parseCanonical(
    version: SourceJobVersion,
    _context: ParserContext,
    document: CanonicalDocument,
  ): Promise<ExtractionCandidate> {
    try {
      const evidence: EvidenceCandidate[] = [];
      const titleSection = document.sections.find((section) => section.kind === "title");
      evidence.push(evidenceCandidate("title", document.title, version.sourceUrl, "canonical title", titleSection));
      const structured: ParsedJob = {
        title: document.title,
        descriptionText: document.fullText.slice(0, 50_000),
        employmentTypes: extractEmployment(document, version.sourceUrl, evidence),
        visaSupport: extractVisa(document, version.sourceUrl, evidence),
        locations: extractLocations(document, version.sourceUrl, evidence),
        languages: extractLanguages(document, version.sourceUrl, evidence),
        skills: extractSkills(document, version.sourceUrl, evidence),
        compensation: extractCompensation(document, version.sourceUrl, evidence),
        experienceRequirements: extractExperienceRequirements(document, version.sourceUrl, evidence),
        jobDates: extractJobDates(document, version.sourceUrl, evidence),
      };
      return { status: "succeeded", structured, evidence, errors: [] };
    } catch (error) {
      return failed(error);
    }
  }
}

function extractEmployment(document: CanonicalDocument, sourceUrl: string, evidence: EvidenceCandidate[]): Fact<string> {
  const sources = document.sections.filter((section) => section.kind === "title" || section.kind === "employment"
    || /雇用形態|正社員|契約社員|派遣社員|業務委託|full[- ]time|permanent\s+employee/i.test(section.text));
  const values: string[] = [];
  for (const section of sources) {
    for (const value of normalizeEmploymentValues(section.text)) {
      if (values.includes(value)) continue;
      values.push(value);
      evidence.push(evidenceCandidate("employmentTypes", employmentQuote(section.text, value), sourceUrl,
        "employment normalizer", section));
    }
  }
  return fact(values, sources.some((section) => section.kind === "employment") ? "not_parsed" : "not_mentioned");
}

function extractLocations(document: CanonicalDocument, sourceUrl: string, evidence: EvidenceCandidate[]): Fact<LocationFact> {
  const sections = document.sections.filter((section) => section.kind === "location");
  const values: LocationFact[] = [];
  for (const section of sections) {
    const value = normalizeLocationText(section.text);
    if (value === null || values.some((candidate) => stableJson(candidate) === stableJson(value))) continue;
    values.push(value);
    evidence.push(evidenceCandidate("locations", conciseQuote(section.text, 500), sourceUrl, "location normalizer", section));
  }
  const reason: FactUnknownReason = sections.length > 0 || /勤務地|勤務場所|就業場所|住所|location/i.test(document.fullText)
    ? "not_parsed" : "not_mentioned";
  const compact = values.filter((value, index) => !values.some((candidate, candidateIndex) => candidateIndex !== index
    && candidate.countryCode === value.countryCode && candidate.prefecture === value.prefecture && candidate.city === value.city
    && candidate.remoteScope === value.remoteScope && value.addressText.includes(candidate.addressText)
    && candidate.addressText.length < value.addressText.length));
  return fact(compact, reason);
}

function extractCompensation(document: CanonicalDocument, sourceUrl: string, evidence: EvidenceCandidate[]): Fact<CompensationFact> {
  const sections = document.sections.filter((section) => section.kind === "compensation"
    || /年収|年俸|月給|基本給|日給|時給|salary|compensation|[￥¥]\s*\d+\s*K/i.test(section.text));
  const values: CompensationFact[] = [];
  for (const section of sections) {
    for (const value of normalizeCompensationText(section.text)) {
      if (values.some((candidate) => stableJson(candidate) === stableJson(value))) continue;
      values.push(value);
      evidence.push(evidenceCandidate("compensation", compensationQuote(section.text), sourceUrl,
        "compensation normalizer", section));
    }
  }
  const reason: FactUnknownReason = sections.length > 0 || /年収|月給|時給|給与|salary|compensation/i.test(document.fullText)
    ? "unsupported_format" : "not_mentioned";
  return fact(values, reason);
}

function extractSkills(document: CanonicalDocument, sourceUrl: string, evidence: EvidenceCandidate[]): Fact<SkillFact> {
  const explicit = document.sections.filter((section) => ["skills", "required_requirements", "preferred_requirements"].includes(section.kind));
  const sources = explicit.length > 0 ? explicit : document.sections.filter((section) => hasSkillSignal(section.text));
  const values: SkillFact[] = [];
  for (const section of sources) {
    const requirementKind = section.kind === "preferred_requirements" ? "preferred"
      : section.kind === "required_requirements" ? "required" : "mentioned";
    for (const value of normalizeSkillFacts(section.text, requirementKind)) {
      if (values.some((candidate) => candidate.normalizedSkill === value.normalizedSkill
        && candidate.requirementKind === value.requirementKind)) continue;
      values.push(value);
      evidence.push(evidenceCandidate("skills", value.originalText, sourceUrl, "skill dictionary", section));
    }
  }
  return fact(preferStrongestRequirement(values, (value) => value.normalizedSkill), sources.length > 0 ? "not_parsed" : "not_mentioned");
}

function extractLanguages(document: CanonicalDocument, sourceUrl: string, evidence: EvidenceCandidate[]): Fact<LanguageFact> {
  const explicit = document.sections.filter((section) => ["languages", "required_requirements", "preferred_requirements"].includes(section.kind));
  const sources = explicit.length > 0 ? explicit : document.sections.filter((section) => /JLPT|TOEIC|日本語|英語|Japanese|English/i.test(section.text));
  const values: LanguageFact[] = [];
  for (const section of sources) {
    const requirementKind = section.kind === "preferred_requirements" ? "preferred"
      : section.kind === "required_requirements" || section.kind === "languages" ? "required" : "mentioned";
    for (const value of normalizeLanguageFacts(section.text, requirementKind)) {
      if (values.some((candidate) => stableJson(candidate) === stableJson(value))) continue;
      values.push(value);
      evidence.push(evidenceCandidate("languages", languageQuote(section.text, value.languageCode), sourceUrl,
        "language normalizer", section));
    }
  }
  return fact(preferStrongestRequirement(values, (value) => `${value.languageCode}:${value.minimumLevel ?? ""}`),
    sources.length > 0 ? "not_parsed" : "not_mentioned");
}

function extractExperienceRequirements(
  document: CanonicalDocument,
  sourceUrl: string,
  evidence: EvidenceCandidate[],
): Fact<ExperienceRequirementFact> {
  const sources = document.sections.filter((section) => ["experience", "required_requirements", "preferred_requirements"].includes(section.kind)
    || /(?:実務経験|開発経験|業務経験|エンジニア経験).{0,24}\d{1,2}\s*年|\d{1,2}\+?\s+years?.{0,36}experience/i.test(section.text));
  const values: ExperienceRequirementFact[] = [];
  const patterns = [
    /(?:実務経験|開発経験|業務経験|エンジニア経験)[^。\n]{0,24}?(\d{1,2})\s*年(?:以上|超)/gi,
    /(?:at\s+least\s+)?(\d{1,2})\+?\s+years?[^.\n]{0,36}(?:experience|professional)/gi,
  ];
  for (const section of sources) {
    for (const pattern of patterns) {
      for (const match of section.text.matchAll(pattern)) {
        const years = Number(match[1]);
        if (!Number.isInteger(years) || years < 1 || years > 30) continue;
        const value: ExperienceRequirementFact = {
          minimumYears: years,
          originalText: match[0],
          requirementKind: section.kind === "preferred_requirements" ? "preferred" : "required",
        };
        if (values.some((candidate) => candidate.minimumYears === value.minimumYears
          && candidate.requirementKind === value.requirementKind)) continue;
        values.push(value);
        evidence.push(evidenceCandidate("experienceRequirements", value.originalText, sourceUrl,
          "experience normalizer", section));
      }
    }
  }
  return fact(values, sources.length > 0 ? "not_parsed" : "not_mentioned");
}

function extractVisa(document: CanonicalDocument, sourceUrl: string, evidence: EvidenceCandidate[]): Fact<boolean> {
  const positive = /(visa\s+(sponsorship|support)(\s+(is\s+)?available)?|ビザ.{0,12}(支援|サポート)|在留資格.{0,18}(取得|変更|更新).{0,12}(支援|可能))/gi;
  const negative = /(no\s+visa\s+(sponsorship|support)|visa\s+(sponsorship|support)\s+(is\s+)?not\s+available|ビザ.{0,12}(支援|サポート).{0,10}(なし|不可)|在留資格.{0,18}(支援不可|対象外))/gi;
  const values: boolean[] = [];
  for (const [value, pattern] of [[true, positive], [false, negative]] as const) {
    const match = pattern.exec(document.fullText);
    pattern.lastIndex = 0;
    if (match === null) continue;
    values.push(value);
    evidence.push(evidenceCandidate("visaSupport", match[0], sourceUrl, "visa rule", findSection(document, match[0])));
  }
  const uniqueValues = [...new Set(values)];
  if (uniqueValues.length === 0) return unknown("not_mentioned");
  return { state: uniqueValues.length > 1 ? "conflicting" : "known", values: uniqueValues };
}

function extractJobDates(
  document: CanonicalDocument,
  sourceUrl: string,
  evidence: EvidenceCandidate[],
): ParsedJob["jobDates"] {
  const dateSections = document.sections.filter((section) => section.kind === "dates");
  return {
    published: datesFor("jobDates.published", dateSections.filter((section) => /掲載|公開|投稿日|published|released|dateposted/i.test(`${section.heading ?? ""} ${section.text}`)), sourceUrl, evidence),
    sourceUpdated: datesFor("jobDates.sourceUpdated", dateSections.filter((section) => /更新|modified|updated/i.test(`${section.heading ?? ""} ${section.text}`)), sourceUrl, evidence),
    validThrough: datesFor("jobDates.validThrough", dateSections.filter((section) => /締切|期限|valid|expire/i.test(`${section.heading ?? ""} ${section.text}`)), sourceUrl, evidence),
  };
}

function datesFor(fieldPath: string, sections: CanonicalDocumentSection[], sourceUrl: string,
  evidence: EvidenceCandidate[]): Fact<JobDateValue> {
  const values: JobDateValue[] = [];
  for (const section of sections) {
    const rawValues = section.text.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T ][0-9:.+Z-]+)?/g) ?? [];
    for (const raw of rawValues) {
      const parsed = parseJobDate(raw);
      if (parsed === null || values.some((value) => stableJson(value) === stableJson(parsed))) continue;
      values.push(parsed);
      evidence.push(evidenceCandidate(fieldPath, raw, sourceUrl, "date normalizer", section));
    }
  }
  if (values.length === 0) return unknown(sections.length > 0 ? "unsupported_format" : "not_mentioned");
  return { state: values.length > 1 ? "conflicting" : "known", values };
}

function parseJobDate(input: string): JobDateValue | null {
  const normalizedDate = input.trim().replaceAll("/", "-");
  const dateOnly = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(normalizedDate);
  if (dateOnly?.[1] !== undefined && dateOnly[2] !== undefined && dateOnly[3] !== undefined) {
    const value = `${dateOnly[1]}-${dateOnly[2].padStart(2, "0")}-${dateOnly[3].padStart(2, "0")}`;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? { value, precision: "date" } : null;
  }
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp) ? { value: new Date(timestamp).toISOString(), precision: "datetime" } : null;
}

function fact<T>(values: T[], reason: FactUnknownReason): Fact<T> {
  return values.length === 0 ? unknown(reason) : { state: "known", values };
}

function unknown<T>(unknownReason: FactUnknownReason): Fact<T> {
  return { state: "unknown", values: [], unknownReason };
}

function evidenceCandidate(fieldPath: string, quotedText: string, sourceUrl: string, rule: string,
  section?: CanonicalDocumentSection): EvidenceCandidate {
  return {
    fieldPath,
    quotedText: conciseQuote(quotedText, 1_500),
    sourceUrl,
    locator: {
      ...(section?.locator ?? { kind: "canonical_document" }),
      ...(section?.id === undefined ? {} : { sectionId: section.id }),
      ...(section === undefined ? {} : { sectionOrdinal: section.ordinal }),
      rule,
    },
  };
}

function findSection(document: CanonicalDocument, quote: string): CanonicalDocumentSection | undefined {
  return document.sections.find((section) => section.text.includes(quote));
}

function employmentQuote(text: string, normalized: string): string {
  const patterns: Record<string, RegExp> = {
    permanent: /【?正社員】?|正規社員|permanent\s+employee|full[- ]time/i,
    fixed_term: /契約社員|有期雇用|fixed[- ]term|contract\s+employee/i,
    dispatch: /派遣社員|dispatch\s+worker/i,
    independent_contractor: /業務委託|請負|independent\s+contractor|freelance/i,
    part_time: /アルバイト|パート|part[- ]time/i,
    ses_on_site: /SES常駐|客先常駐/i,
  };
  return patterns[normalized]?.exec(text)?.[0] ?? conciseQuote(text, 240);
}

function compensationQuote(text: string): string {
  return text.match(/(?:年収|年俸|月給|基本給|日給|時給|salary|compensation)[^\n。]{0,120}/i)?.[0]
    ?? conciseQuote(text, 240);
}

function languageQuote(text: string, language: string): string {
  const pattern = language === "ja" ? /[^\n。]{0,30}(?:JLPT|日本語|Japanese)[^\n。]{0,50}/i
    : language === "en" ? /[^\n。]{0,30}(?:TOEIC|英語|English)[^\n。]{0,50}/i
      : /[^\n。]{0,30}(?:中国語|Mandarin|Chinese)[^\n。]{0,50}/i;
  return pattern.exec(text)?.[0] ?? conciseQuote(text, 240);
}

function hasSkillSignal(text: string): boolean {
  return /TypeScript|JavaScript|React|Python|Java|AWS|Excel|Word|PowerPoint|VBA|スキル/i.test(text);
}

function preferStrongestRequirement<T extends { requirementKind: "required" | "preferred" | "mentioned" }>(
  values: T[],
  key: (value: T) => string,
): T[] {
  const weight = { required: 3, preferred: 2, mentioned: 1 } as const;
  const selected = new Map<string, T>();
  for (const value of values) {
    const current = selected.get(key(value));
    if (current === undefined || weight[value.requirementKind] > weight[current.requirementKind]) selected.set(key(value), value);
  }
  return [...selected.values()];
}

function conciseQuote(value: string, maximum: number): string {
  const cleaned = value.trim();
  return cleaned.length <= maximum ? cleaned : cleaned.slice(0, maximum);
}

function failed(error: unknown): ExtractionCandidate {
  return { status: "failed", structured: {}, evidence: [], errors: [error instanceof Error ? error.message : String(error)] };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
