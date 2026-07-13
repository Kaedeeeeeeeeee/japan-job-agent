import { load } from "cheerio";
import type {
  EvidenceCandidate,
  ExtractionCandidate,
  JobParser,
  ParserContext,
  SourceJobVersion,
} from "../../contracts/src/index.js";
import { findJobPosting } from "../../connectors-schema-org/src/schema-org-connector.js";

export interface Fact<T> {
  state: "known" | "unknown" | "conflicting";
  values: T[];
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
}

export class DeterministicJobParser implements JobParser {
  readonly parserKey = "deterministic-job";
  readonly parserVersion = "1.4.0";
  readonly schemaVersion = "job-v1";

  async parse(version: SourceJobVersion, _context: ParserContext): Promise<ExtractionCandidate> {
    try {
      const document = sourceDocument(version.raw);
      const evidence: EvidenceCandidate[] = [];
      if (document.title.length > 0) {
        evidence.push(quote("title", document.title, version.sourceUrl, "source title"));
      }
      const employmentTypes = extractEmployment(document, version.sourceUrl, evidence);
      const visaSupport = extractVisa(document.searchText, version.sourceUrl, evidence);
      const locations = extractLocations(document, version.sourceUrl, evidence);
      const languages = extractLanguages(document.searchText, version.sourceUrl, evidence);
      const skills = extractSkills(document.searchText, version.sourceUrl, evidence);
      const compensation = extractCompensation(document.searchText, version.sourceUrl, evidence);
      const experienceRequirements = extractExperienceRequirements(document.searchText, version.sourceUrl, evidence);
      const structured: ParsedJob = {
        title: document.title,
        descriptionText: document.descriptionText,
        employmentTypes,
        visaSupport,
        locations,
        languages,
        skills,
        compensation,
        experienceRequirements,
      };
      return {
        status: "succeeded",
        structured,
        evidence,
        errors: [],
      };
    } catch (error) {
      return {
        status: "failed",
        structured: {},
        evidence: [],
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  }
}

interface SourceDocument {
  title: string;
  descriptionText: string;
  searchText: string;
  locationTexts: string[];
  employmentTexts: string[];
}

function sourceDocument(raw: Uint8Array): SourceDocument {
  const input = new TextDecoder().decode(raw);
  if (input.trimStart().startsWith("{")) {
    const job = JSON.parse(input) as Record<string, unknown>;
    return documentFromObject(job);
  }
  try {
    return documentFromObject(findJobPosting(raw));
  } catch {
    return documentFromHtml(input);
  }
}

function documentFromHtml(input: string): SourceDocument {
  const $ = load(input);
  $("script,style,noscript,nav,footer,header").remove();
  const title = cleanHtmlText($("h1").first().text())
    || cleanHtmlText($('meta[property="og:title"]').attr("content") ?? "")
    || cleanHtmlText($("title").first().text());
  const content = $("main").first().length > 0 ? $("main").first() : $("body").first();
  const descriptionText = cleanHtmlText(content.text());
  if (title === "" || descriptionText.length < 40) throw new Error("HTML job detail has insufficient title or body content");
  return { title, descriptionText, searchText: `${title}\n${descriptionText}`, locationTexts: [], employmentTexts: [] };
}

function documentFromObject(job: Record<string, unknown>): SourceDocument {
  const title = text(job.title) ?? "";
  const descriptionHtml = text(job.description) ?? text(job.content) ?? "";
  const descriptionText = htmlText(descriptionHtml);
  const locationTexts = extractLocationTexts(job);
  const employmentTexts = array(job.employmentType).filter((value): value is string => typeof value === "string");
  return {
    title,
    descriptionText,
    searchText: [title, ...locationTexts, descriptionText, JSON.stringify(job.baseSalary ?? "")].join("\n"),
    locationTexts,
    employmentTexts,
  };
}

function htmlText(html: string): string {
  const $ = load(`<main>${html}</main>`);
  $("script,style,noscript").remove();
  $("p,div,li,section,article,h1,h2,h3,h4,h5,h6,br").each((_, element) => {
    $(element).append(" ");
  });
  return $("main").text().replace(/\s+/g, " ").trim();
}

function cleanHtmlText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractLocationTexts(job: Record<string, unknown>): string[] {
  const output: string[] = [];
  const direct = job.location;
  if (direct !== null && typeof direct === "object" && "name" in direct && typeof direct.name === "string") output.push(direct.name);
  for (const location of array(job.jobLocation)) {
    if (location === null || typeof location !== "object") continue;
    const address = "address" in location ? location.address : undefined;
    if (typeof address === "string") output.push(address);
    if (address !== null && typeof address === "object") {
      output.push(["addressRegion", "addressLocality", "streetAddress", "addressCountry"]
        .map((key) => key in address ? text(address[key as keyof typeof address]) : undefined)
        .filter((value): value is string => value !== undefined).join(" "));
    }
  }
  const remote = text(job.jobLocationType);
  if (remote !== undefined) output.push(remote);
  return output.filter((value) => value.length > 0);
}

function extractEmployment(document: SourceDocument, sourceUrl: string, evidence: EvidenceCandidate[]): Fact<string> {
  const input = document.searchText;
  const patterns: Array<[string, RegExp]> = [
    ["permanent", /正社員|permanent\s+employee|full[- ]time/gi],
    ["fixed_term", /契約社員|fixed[- ]term|contract\s+employee/gi],
    ["dispatch", /派遣社員|dispatch\s+worker/gi],
    ["independent_contractor", /業務委託|independent\s+contractor|freelance/gi],
    ["part_time", /アルバイト|パートタイム|part[- ]time/gi],
  ];
  const values: string[] = [];
  for (const original of document.employmentTexts) {
    const normalized = original.toUpperCase();
    const value = normalized === "FULL_TIME" || /正社員|PERMANENT/.test(normalized) ? "permanent"
      : normalized === "PART_TIME" || /パート|アルバイト/.test(original) ? "part_time"
      : normalized === "CONTRACTOR" ? "independent_contractor"
      : normalized === "TEMPORARY" || /契約社員/.test(original) ? "fixed_term"
      : null;
    if (value !== null && !values.includes(value)) {
      values.push(value);
      evidence.push(quote("employmentTypes", original, sourceUrl, "schema.org employmentType"));
    }
  }
  for (const [value, pattern] of patterns) {
    const match = pattern.exec(input);
    pattern.lastIndex = 0;
    if (match === null) continue;
    const context = input.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40);
    if (!/雇用形態|雇用区分|契約区分|employment\s+type/i.test(context)) continue;
    if (!values.includes(value)) values.push(value);
    evidence.push(quote("employmentTypes", match[0], sourceUrl, pattern.source));
  }
  return fact(values);
}

function extractVisa(input: string, sourceUrl: string, evidence: EvidenceCandidate[]): Fact<boolean> {
  const positive = /(visa\s+(sponsorship|support)(\s+(is\s+)?available)?|ビザ.{0,12}(支援|サポート)|在留資格.{0,18}(取得|変更|更新).{0,12}(支援|可能))/gi;
  const negative = /(no\s+visa\s+(sponsorship|support)|visa\s+(sponsorship|support)\s+(is\s+)?not\s+available|ビザ.{0,12}(支援|サポート).{0,10}(なし|不可)|在留資格.{0,18}(支援不可|対象外))/gi;
  const positiveMatch = positive.exec(input);
  const negativeMatch = negative.exec(input);
  const values: boolean[] = [];
  if (positiveMatch !== null) {
    values.push(true);
    evidence.push(quote("visaSupport", positiveMatch[0], sourceUrl, positive.source));
  }
  if (negativeMatch !== null) {
    values.push(false);
    evidence.push(quote("visaSupport", negativeMatch[0], sourceUrl, negative.source));
  }
  if (values.length === 0) return { state: "unknown", values: [] };
  return { state: new Set(values).size > 1 ? "conflicting" : "known", values: [...new Set(values)] };
}

function extractLocations(document: SourceDocument, sourceUrl: string, evidence: EvidenceCandidate[]): Fact<LocationFact> {
  const locations: LocationFact[] = [];
  for (const original of document.locationTexts) {
    const japan = /Japan|日本|Tokyo|東京|Fukuoka|福岡|Osaka|大阪/i.test(original);
    const remote = /remote|リモート|在宅|telecommute/i.test(original);
    locations.push({
      countryCode: japan ? "JP" : null,
      prefecture: /Tokyo|東京/i.test(original) ? "東京都" : /Fukuoka|福岡/i.test(original) ? "福岡県" : /Osaka|大阪/i.test(original) ? "大阪府" : null,
      city: null,
      addressText: original,
      remoteScope: remote ? (japan ? "japan" : "unspecified") : null,
    });
    evidence.push(quote("locations", original, sourceUrl, "structured location"));
  }
  return fact(locations);
}

function extractLanguages(input: string, sourceUrl: string, evidence: EvidenceCandidate[]): Fact<LanguageFact> {
  const results: LanguageFact[] = [];
  const patterns: Array<[string, RegExp]> = [
    ["ja", /(JLPT\s*N[1-5]|日本語.{0,16}(ネイティブ|ビジネス|日常会話|N[1-5]))/gi],
    ["en", /(TOEIC\s*\d{3,4}|英語.{0,16}(ネイティブ|ビジネス|日常会話))/gi],
    ["zh", /(中国語.{0,16}(ネイティブ|ビジネス|日常会話)|Mandarin|Chinese)/gi],
  ];
  for (const [languageCode, pattern] of patterns) {
    const match = pattern.exec(input);
    if (match === null) continue;
    const preferredWindow = input.slice(Math.max(0, match.index - 20), match.index + match[0].length + 20);
    results.push({
      languageCode,
      minimumLevel: match[0].match(/N[1-5]|\d{3,4}|ネイティブ|ビジネス|日常会話/i)?.[0] ?? null,
      requirementKind: /歓迎|preferred|nice to have/i.test(preferredWindow) ? "preferred" : "required",
    });
    evidence.push(quote("languages", match[0], sourceUrl, pattern.source));
  }
  return fact(results);
}

function extractSkills(input: string, sourceUrl: string, evidence: EvidenceCandidate[]): Fact<SkillFact> {
  const dictionary = ["TypeScript", "JavaScript", "React", "Next.js", "Node.js", "Python", "Java", "Go", "AWS", "GCP", "Docker", "Kubernetes", "PostgreSQL", "AI", "LLM", "iOS", "Swift", "Unity"];
  const results: SkillFact[] = [];
  for (const skill of dictionary) {
    const pattern = new RegExp(`\\b${escapeRegExp(skill).replaceAll("\\.", "\\.?")}\\b`, "i");
    const match = pattern.exec(input);
    if (match === null) continue;
    results.push({ normalizedSkill: skill.toLowerCase(), originalText: match[0], requirementKind: "mentioned" });
    evidence.push(quote("skills", match[0], sourceUrl, pattern.source));
  }
  return fact(results);
}

function extractCompensation(input: string, sourceUrl: string, evidence: EvidenceCandidate[]): Fact<CompensationFact> {
  const range = /(?:年収|想定年収)?\s*(\d{3,4})\s*万円?\s*(?:[〜～~-]|から)\s*(\d{3,4})\s*万円?/i.exec(input);
  if (range?.[1] !== undefined && range[2] !== undefined) {
    evidence.push(quote("compensation", range[0], sourceUrl, "jpy annual range"));
    return {
      state: "known",
      values: [{
        compensationKind: /試用期間/.test(input.slice(Math.max(0, range.index - 30), range.index + range[0].length + 10)) ? "trial" : "total",
        currency: "JPY", period: "year", minimumAmount: Number(range[1]) * 10_000,
        maximumAmount: Number(range[2]) * 10_000, isCalculated: false,
      }],
    };
  }
  const monthly = /(?:月給|初任給)[：:\s]*(\d{2,3}(?:,\d{3})?)\s*円/i.exec(input);
  if (monthly?.[1] === undefined) return { state: "unknown", values: [] };
  evidence.push(quote("compensation", monthly[0], sourceUrl, "jpy monthly amount"));
  const amount = Number(monthly[1].replaceAll(",", ""));
  return { state: "known", values: [{ compensationKind: "base", currency: "JPY", period: "month",
    minimumAmount: amount, maximumAmount: amount, isCalculated: false }] };
}

function extractExperienceRequirements(input: string, sourceUrl: string, evidence: EvidenceCandidate[]): Fact<ExperienceRequirementFact> {
  const results: ExperienceRequirementFact[] = [];
  const patterns = [
    /(?:実務経験|開発経験|業務経験|エンジニア経験)[^。\n]{0,24}?(\d{1,2})\s*年(?:以上|超)/gi,
    /(?:at\s+least\s+)?(\d{1,2})\+?\s+years?[^.\n]{0,36}(?:experience|professional)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of input.matchAll(pattern)) {
      const years = Number(match[1]);
      if (!Number.isInteger(years) || years < 1 || years > 30) continue;
      const originalText = match[0];
      const index = match.index ?? 0;
      const window = input.slice(Math.max(0, index - 20), index + originalText.length + 20);
      results.push({ minimumYears: years, originalText,
        requirementKind: /歓迎|尚可|preferred|nice to have/i.test(window) ? "preferred" : "required" });
      evidence.push(quote("experienceRequirements", originalText, sourceUrl, pattern.source));
    }
  }
  const unique = results.filter((value, index) => results.findIndex((candidate) => candidate.minimumYears === value.minimumYears
    && candidate.requirementKind === value.requirementKind) === index);
  return fact(unique);
}

function fact<T>(values: T[]): Fact<T> {
  return values.length === 0 ? { state: "unknown", values: [] } : { state: "known", values };
}

function quote(fieldPath: string, quotedText: string, sourceUrl: string, rule: string): EvidenceCandidate {
  return { fieldPath, quotedText, sourceUrl, locator: { kind: "deterministic_rule", rule } };
}

function array(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
