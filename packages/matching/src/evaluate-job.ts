import type { SafeProfile } from "../../profile/src/build-profile.js";

interface Fact<T> {
  state: "known" | "unknown" | "conflicting";
  values: T[];
}

export interface CanonicalJobForMatch {
  canonicalJobId: string;
  canonicalJobVersionId: string;
  lifecycleState: "active" | "suspect" | "closed";
  verifiedOfficialSource: boolean;
  title: string;
  applicationUrl: string;
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
}

export function evaluateJob(profile: SafeProfile, job: CanonicalJobForMatch): JobMatchResult {
  const hardRejectReasons: string[] = [];
  const matched: MatchItem[] = [];
  const gaps: MatchItem[] = [];
  const unknowns: MatchItem[] = [];
  if (job.lifecycleState !== "active") hardRejectReasons.push("job_not_active");
  if (!job.verifiedOfficialSource) hardRejectReasons.push("no_verified_official_source");

  const employment = fact<string>(job.structured.employmentTypes);
  const employmentEvidence = evidence(job, "employmentTypes");
  const employmentPolicy = profile.employment as { preferred: string[]; needsConfirmation: string[]; excluded: string[] };
  if (employment.state === "unknown") unknowns.push(item("employmentTypes", "雇用形態は原文で確認できません", []));
  else {
    const excluded = employment.values.filter((value) => employmentPolicy.excluded.includes(value));
    if (excluded.length > 0) {
      hardRejectReasons.push("explicitly_excluded_employment");
      gaps.push(item("employmentTypes", `対象外の雇用形態: ${excluded.join(", ")}`, employmentEvidence));
    }
    const preferred = employment.values.filter((value) => employmentPolicy.preferred.includes(value));
    if (preferred.length > 0) matched.push(item("employmentTypes", `希望雇用形態: ${preferred.join(", ")}`, employmentEvidence));
    const confirm = employment.values.filter((value) => employmentPolicy.needsConfirmation.includes(value));
    if (confirm.length > 0) unknowns.push(item("employmentTypes", `確認が必要な雇用形態: ${confirm.join(", ")}`, employmentEvidence));
  }

  const locations = fact<{ countryCode?: string | null; prefecture?: string | null; remoteScope?: string | null; addressText?: string }>(job.structured.locations);
  const locationEvidence = evidence(job, "locations");
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

  const profileSkills = new Set(profile.normalizedSkills.map((skill) => skill.toLowerCase()));
  const skills = fact<{ normalizedSkill?: string; requirementKind?: string }>(job.structured.skills);
  if (skills.state === "unknown") unknowns.push(item("skills", "必要スキルは構造化できませんでした", []));
  else {
    const skillEvidence = evidence(job, "skills");
    const hits = skills.values.filter((value) => value.normalizedSkill !== undefined && profileSkills.has(value.normalizedSkill));
    if (hits.length > 0) matched.push(item("skills", `一致スキル: ${hits.map((value) => value.normalizedSkill).join(", ")}`, skillEvidence));
    const requiredMissing = skills.values.filter((value) => value.requirementKind === "required"
      && value.normalizedSkill !== undefined && !profileSkills.has(value.normalizedSkill));
    if (requiredMissing.length > 0) gaps.push(item("skills", `未確認の必須スキル: ${requiredMissing.map((value) => value.normalizedSkill).join(", ")}`, skillEvidence));
  }

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

  const visa = fact<boolean>(job.structured.visaSupport);
  if (visa.state === "unknown") unknowns.push(item("visaSupport", "ビザ支援は不明（ハード除外しません）", []));
  else if (visa.state === "conflicting") gaps.push(item("visaSupport", "ビザ支援の原文が矛盾しています", evidence(job, "visaSupport")));
  else if (visa.values.includes(true)) matched.push(item("visaSupport", "ビザ支援の記載あり", evidence(job, "visaSupport")));
  else gaps.push(item("visaSupport", "ビザ支援なしの記載（情報提示のみ）", evidence(job, "visaSupport")));

  const compensation = fact<{ minimumAmount?: number | null; maximumAmount?: number | null; period?: string }>(job.structured.compensation);
  if (compensation.state === "unknown") unknowns.push(item("compensation", "給与不明（ハード除外しません）", []));
  else matched.push(item("compensation", "給与原文を取得済み", evidence(job, "compensation")));

  if (/engineer|developer|エンジニア|プロダクト|AI|Web/i.test(job.title)) {
    matched.push(item("roleDirection", "希望職種方向に一致", []));
  }
  return { canonicalJobId: job.canonicalJobId, canonicalJobVersionId: job.canonicalJobVersionId,
    eligible: hardRejectReasons.length === 0, hardRejectReasons, matched, gaps, unknowns };
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

