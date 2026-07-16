import type { SafeProfile } from "../../profile/src/build-profile.js";
import {
  classifyOccupation,
  rolePriorityWeight,
  type OccupationClassification,
} from "../../occupations/src/occupation-taxonomy-v1.js";

interface Fact<T> {
  state: "known" | "unknown" | "conflicting";
  values: T[];
}

export interface CanonicalJobForMatch {
  canonicalJobId: string;
  canonicalJobVersionId: string;
  lifecycleState: "active" | "suspect" | "closed";
  verifiedOfficialSource: boolean;
  readiness?: "ready" | "pending_enrichment" | "needs_review";
  title: string;
  applicationUrl: string;
  fetchedAt?: string;
  occupation?: OccupationClassification;
  structured: Record<string, unknown>;
  evidenceByField: Record<string, string[]>;
}

export interface MatchItem {
  field: string;
  message: string;
  evidenceIds: string[];
}

export interface JobMatchResult {
  canonicalJobId: string;
  canonicalJobVersionId: string;
  eligible: boolean;
  hardRejectReasons: string[];
  matched: MatchItem[];
  gaps: MatchItem[];
  unknowns: MatchItem[];
  score: number;
  scoreBreakdown: ScoreDimension[];
}

export interface ScoreDimension {
  key: "role_direction" | "skills" | "language" | "recruitment_channel" | "location_remote" | "employment" | "compensation" | "freshness_source";
  label: string;
  score: number;
  maximum: number;
  evidenceIds: string[];
  rationale: string;
}

export function evaluateJob(profile: SafeProfile, job: CanonicalJobForMatch): JobMatchResult {
  const hardRejectReasons: string[] = [];
  const matched: MatchItem[] = [];
  const gaps: MatchItem[] = [];
  const unknowns: MatchItem[] = [];
  const scoreBreakdown: ScoreDimension[] = [];
  if (job.lifecycleState !== "active") hardRejectReasons.push("job_not_active");
  if (!job.verifiedOfficialSource) hardRejectReasons.push("no_verified_official_source");

  const employment = fact<string>(job.structured.employmentTypes);
  const titleEmployment = explicitEmploymentFromTitle(job.title);
  const employmentValues = [...new Set([...employment.values, ...titleEmployment])];
  const employmentEvidence = [...new Set([
    ...evidence(job, "employmentTypes"), ...(titleEmployment.length > 0 ? evidence(job, "title") : []),
  ])];
  const employmentUnknown = employment.state === "unknown" && employmentValues.length === 0;
  if (employment.state !== "known" || job.readiness !== undefined && job.readiness !== "ready") {
    if (!hardRejectReasons.includes("employment_unresolved") && employment.state !== "known") {
      hardRejectReasons.push("employment_unresolved");
    }
  }
  const employmentPolicy = profile.employment as { preferred: string[]; needsConfirmation: string[]; excluded: string[] };
  if (employmentUnknown) unknowns.push(item("employmentTypes", "雇用形態は原文で確認できません", []));
  else {
    const excluded = employmentValues.filter((value) => employmentPolicy.excluded.includes(value));
    if (excluded.length > 0) {
      hardRejectReasons.push("explicitly_excluded_employment");
      gaps.push(item("employmentTypes", `対象外の雇用形態: ${excluded.join(", ")}`, employmentEvidence));
    }
    const preferred = employmentValues.filter((value) => employmentPolicy.preferred.includes(value));
    if (preferred.length > 0) matched.push(item("employmentTypes", `希望雇用形態: ${preferred.map(employmentLabel).join(", ")}`, employmentEvidence));
    const confirm = employmentValues.filter((value) => employmentPolicy.needsConfirmation.includes(value));
    if (confirm.length > 0) unknowns.push(item("employmentTypes", `確認が必要な雇用形態: ${confirm.join(", ")}`, employmentEvidence));
  }
  scoreBreakdown.push(dimension("employment", "雇用形態", employmentUnknown ? 0 :
    employmentValues.some((value) => employmentPolicy.preferred.includes(value)) ? 5 :
      employmentValues.some((value) => employmentPolicy.needsConfirmation.includes(value)) ? 3 : 0,
  5, employmentEvidence, employmentUnknown ? "雇用形態は不明" : "希望雇用形態との一致度"));

  const locations = fact<{ countryCode?: string | null; prefecture?: string | null; remoteScope?: string | null; addressText?: string }>(job.structured.locations);
  const locationEvidence = evidence(job, "locations");
  if (locations.state !== "known") hardRejectReasons.push("location_unresolved");
  if (locations.state === "unknown") unknowns.push(item("locations", "勤務地・リモート範囲は不明です", []));
  else {
    const accepted = locations.values.some((value) => value.remoteScope === "japan" || value.prefecture === "東京都"
      || /Tokyo|東京|神奈川|千葉|埼玉/.test(value.addressText ?? ""));
    const explicitConflict = locations.values.length > 0 && locations.values.every((value) =>
      value.countryCode !== null && value.countryCode !== undefined && value.countryCode !== "JP"
      || (value.countryCode === "JP" && value.remoteScope === null && value.prefecture !== null && value.prefecture !== "東京都"
        && !/神奈川|千葉|埼玉/.test(value.addressText ?? "")));
    if (accepted) matched.push(item("locations", "東京圏または日本国内リモートに一致", locationEvidence));
    else if (explicitConflict) {
      hardRejectReasons.push("explicit_location_conflict");
      gaps.push(item("locations", "勤務地が希望範囲と明確に競合", locationEvidence));
    } else unknowns.push(item("locations", "勤務地の適合範囲を追加確認", locationEvidence));
  }
  const locationAccepted = locations.values.some((value) => value.remoteScope === "japan" || value.prefecture === "東京都"
    || /Tokyo|東京|神奈川|千葉|埼玉/.test(value.addressText ?? ""));
  scoreBreakdown.push(dimension("location_remote", "勤務地・リモート", locations.state === "unknown" ? 0 : locationAccepted ? 10 : 0,
    10, locationEvidence, locations.state === "unknown" ? "勤務地は不明" : locationAccepted ? "希望勤務地に一致" : "希望勤務地との一致なし"));

  const profileSkills = new Set(profile.normalizedSkills.map((skill) => skill.toLowerCase()));
  const skills = fact<{ normalizedSkill?: string; requirementKind?: string }>(job.structured.skills);
  if (skills.state === "unknown") unknowns.push(item("skills", "必要スキルは構造化できませんでした", []));
  else {
    const skillEvidence = evidence(job, "skills");
    const hits = skills.values.filter((value) => value.normalizedSkill !== undefined && profileSkills.has(value.normalizedSkill));
    if (hits.length > 0) matched.push(item("skills", `一致スキル: ${hits.map((value) => skillLabel(value.normalizedSkill)).join(", ")}`, skillEvidence));
    const requiredMissing = skills.values.filter((value) => value.requirementKind === "required"
      && value.normalizedSkill !== undefined && !profileSkills.has(value.normalizedSkill));
    if (requiredMissing.length > 0) gaps.push(item("skills", `未確認の必須スキル: ${requiredMissing.map((value) => value.normalizedSkill).join(", ")}`, skillEvidence));
  }
  const skillValues = skills.values.filter((value) => value.normalizedSkill !== undefined);
  const skillHits = skillValues.filter((value) => profileSkills.has(value.normalizedSkill as string));
  const skillScore = skills.state === "unknown" ? 0 : skillValues.length === 0 ? 0
    : Math.round(25 * skillHits.length / skillValues.length);
  scoreBreakdown.push(dimension("skills", "スキル", skillScore, 25, evidence(job, "skills"),
    skills.state === "unknown" ? "必要スキルは不明" : `${skillHits.length}/${skillValues.length} スキル一致`));

  const languages = fact<{ languageCode?: string; minimumLevel?: string | null; requirementKind?: string }>(job.structured.languages);
  if (languages.state === "unknown") unknowns.push(item("languages", "言語要件は不明です", []));
  else {
    const languageEvidence = evidence(job, "languages");
    const knownLanguages = new Set(profile.languages.map((value) => value.code));
    const languageHits = languages.values.filter((value) => value.languageCode !== undefined && knownLanguages.has(value.languageCode));
    if (languageHits.length > 0) matched.push(item("languages", `対応言語: ${languageHits.map((value) => value.languageCode).join(", ")}`, languageEvidence));
    const missing = languages.values.filter((value) => value.requirementKind === "required"
      && value.languageCode !== undefined && !knownLanguages.has(value.languageCode));
    if (missing.length > 0) gaps.push(item("languages", `未確認の必須言語: ${missing.map((value) => value.languageCode).join(", ")}`, languageEvidence));
  }
  const requiredLanguages = languages.values.filter((value) => value.requirementKind === "required" && value.languageCode !== undefined);
  const knownLanguageCodes = new Set(profile.languages.map((value) => value.code));
  const coveredLanguages = requiredLanguages.filter((value) => knownLanguageCodes.has(value.languageCode as string));
  const languageScore = languages.state === "unknown" ? 0 : requiredLanguages.length === 0 ? 10
    : Math.round(15 * coveredLanguages.length / requiredLanguages.length);
  scoreBreakdown.push(dimension("language", "言語", languageScore, 15, evidence(job, "languages"),
    languages.state === "unknown" ? "言語要件は不明" : `${coveredLanguages.length}/${requiredLanguages.length} 必須言語に対応`));

  const visa = fact<boolean>(job.structured.visaSupport);
  if (visa.state === "unknown") unknowns.push(item("visaSupport", "ビザ支援は不明（ハード除外しません）", []));
  else if (visa.state === "conflicting") gaps.push(item("visaSupport", "ビザ支援の原文が矛盾しています", evidence(job, "visaSupport")));
  else if (visa.values.includes(true)) matched.push(item("visaSupport", "ビザ支援の記載あり", evidence(job, "visaSupport")));
  else gaps.push(item("visaSupport", "ビザ支援なしの記載（情報提示のみ）", evidence(job, "visaSupport")));

  const compensation = fact<{ minimumAmount?: number | null; maximumAmount?: number | null; period?: string }>(job.structured.compensation);
  if (compensation.state === "unknown") unknowns.push(item("compensation", "給与不明（ハード除外しません）", []));
  else matched.push(item("compensation", "給与原文を取得済み", evidence(job, "compensation")));
  const annualTarget = Number((profile.compensation as { annualTarget?: unknown }).annualTarget ?? 4_000_000);
  const compensationMeetsTarget = compensation.values.some((value) => annualizedMaximum(value) >= annualTarget);
  scoreBreakdown.push(dimension("compensation", "給与", compensation.state === "unknown" ? 0 : compensationMeetsTarget ? 5 : 2,
    5, evidence(job, "compensation"), compensation.state === "unknown" ? "給与は不明" : compensationMeetsTarget ? "年収目標に到達可能" : "年収目標未満または換算不能"));

  const description = typeof job.structured.descriptionText === "string" ? job.structured.descriptionText : "";
  const occupation = job.occupation ?? classifyOccupation({
    title: job.title,
    ...(description === "" ? {} : { descriptionText: description }),
  });
  const titleEvidence = evidence(job, "title");
  const roleScore = roleDirectionScore(profile, occupation);
  if (roleScore > 0 && titleEvidence.length > 0) matched.push(item("roleDirection", "希望職種方向に一致", titleEvidence));
  else if (roleScore > 0) unknowns.push(item("roleDirection", "職種方向は一致しますがタイトル証拠を再解析中です", []));
  else if (titleEvidence.length > 0) gaps.push(item("roleDirection", "希望職種方向との一致が弱い", titleEvidence));
  scoreBreakdown.push(dimension("role_direction", "職種方向", roleScore, 25, titleEvidence,
    roleScore >= 20 ? "優先職種に一致" : roleScore > 0 ? "補完職種に一致" : "優先職種との一致なし"));

  const recruitmentText = `${job.title}\n${description}`;
  const channelScore = /27卒|2027.{0,4}卒|新卒|第二新卒|junior|entry.?level/i.test(recruitmentText) ? 10
    : /経験.{0,8}[012]年|未経験|ポテンシャル/i.test(recruitmentText) ? 8 : 3;
  scoreBreakdown.push(dimension("recruitment_channel", "採用枠", channelScore, 10, titleEvidence,
    channelScore === 10 ? "新卒・第二新卒枠を確認" : channelScore === 8 ? "初級採用シグナルあり" : "採用枠の適合は要確認"));

  const sourceEvidence = evidence(job, "sourceVerification");
  const freshness = freshnessScore(job.fetchedAt);
  scoreBreakdown.push(dimension("freshness_source", "鮮度・ソース", (job.verifiedOfficialSource ? 3 : 0) + freshness,
    5, sourceEvidence, job.verifiedOfficialSource ? "公式ソースを検証済み" : "公式ソース未検証"));
  const experience = fact<{ minimumYears?: number; requirementKind?: string }>(job.structured.experienceRequirements);
  const requiredExperience = experience.values.filter((value) => value.requirementKind === "required" && (value.minimumYears ?? 0) >= 3);
  if (requiredExperience.length > 0) gaps.push(item("experienceRequirements",
    `実務経験 ${Math.max(...requiredExperience.map((value) => value.minimumYears ?? 0))} 年以上の要件（要確認）`, evidence(job, "experienceRequirements")));
  const channel = scoreBreakdown.find((value) => value.key === "recruitment_channel");
  if (channel !== undefined && requiredExperience.length > 0 && channel.score < 10) {
    channel.score = 1;
    channel.rationale = "経験年数要件あり";
    channel.evidenceIds = evidence(job, "experienceRequirements");
  }
  const order: ScoreDimension["key"][] = ["role_direction", "skills", "language", "recruitment_channel",
    "location_remote", "employment", "compensation", "freshness_source"];
  scoreBreakdown.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  const score = scoreBreakdown.reduce((sum, value) => sum + value.score, 0);
  return { canonicalJobId: job.canonicalJobId, canonicalJobVersionId: job.canonicalJobVersionId,
    eligible: hardRejectReasons.length === 0, hardRejectReasons, matched, gaps, unknowns, score, scoreBreakdown };
}

function employmentLabel(value: string): string {
  return ({ permanent: "正社員", fixed_term: "契約社員", dispatch: "派遣", independent_contractor: "業務委託",
    part_time: "アルバイト・パート", ses_on_site: "SES常駐" } as Record<string, string>)[value] ?? value;
}

function explicitEmploymentFromTitle(title: string): string[] {
  const values: string[] = [];
  const patterns: Array<[string, RegExp]> = [
    ["permanent", /正社員|full[- ]time/i],
    ["fixed_term", /契約社員|fixed[- ]term|contract employee/i],
    ["dispatch", /派遣社員|【派遣】|\[dispatch\]/i],
    ["independent_contractor", /業務委託|フリーランス|independent contractor|freelance/i],
    ["part_time", /アルバイト|パート(?!ナー)|part[- ]time/i],
    ["ses_on_site", /SES常駐|客先常駐/i],
  ];
  for (const [value, pattern] of patterns) if (pattern.test(title)) values.push(value);
  return values;
}

function skillLabel(value: string | undefined): string {
  if (value === undefined) return "不明";
  return ({ typescript: "TypeScript", javascript: "JavaScript", react: "React", "next.js": "Next.js", "node.js": "Node.js",
    python: "Python", java: "Java", go: "Go", aws: "AWS", gcp: "GCP", ai: "AI", llm: "LLM", ios: "iOS", swift: "Swift", unity: "Unity" } as Record<string, string>)[value] ?? value;
}

function dimension(key: ScoreDimension["key"], label: string, score: number, maximum: number,
  evidenceIds: string[], rationale: string): ScoreDimension {
  return { key, label, score: Math.max(0, Math.min(maximum, score)), maximum, evidenceIds, rationale };
}

function roleDirectionScore(profile: SafeProfile, occupation: OccupationClassification): number {
  const priorities = new Map(profile.rolePriorities.map((value) => [value.group, value.weight]));
  return Math.round(25 * rolePriorityWeight(occupation, priorities));
}

function annualizedMaximum(value: { minimumAmount?: number | null; maximumAmount?: number | null; period?: string }): number {
  const amount = value.maximumAmount ?? value.minimumAmount ?? 0;
  if (value.period === "year") return amount;
  if (value.period === "month") return amount * 12;
  return 0;
}

function freshnessScore(fetchedAt: string | undefined): number {
  if (fetchedAt === undefined) return 1;
  const age = Date.now() - new Date(fetchedAt).getTime();
  if (!Number.isFinite(age)) return 1;
  return age <= 24 * 60 * 60 * 1000 ? 2 : age <= 7 * 24 * 60 * 60 * 1000 ? 1 : 0;
}

function fact<T>(value: unknown): Fact<T> {
  if (value !== null && typeof value === "object" && "state" in value && "values" in value && Array.isArray(value.values)) {
    return value as Fact<T>;
  }
  return { state: "unknown", values: [] };
}

function evidence(job: CanonicalJobForMatch, field: string): string[] {
  return job.evidenceByField[field] ?? [];
}

function item(field: string, message: string, evidenceIds: string[]): MatchItem {
  return { field, message, evidenceIds };
}
