import { load } from "cheerio";

export interface ProfilePolicy extends Record<string, unknown> {
  schemaVersion: string;
  targetChannels: string[];
  rolePriorities: Array<{ group: string; weight: number }>;
  languages: Array<{ code: string; level: string }>;
}

export interface SafeProfile extends Record<string, unknown> {
  schemaVersion: string;
  targetChannels: string[];
  rolePriorities: Array<{ group: string; weight: number }>;
  locations: unknown;
  employment: unknown;
  languages: Array<{ code: string; level: string }>;
  visa: unknown;
  compensation: unknown;
  normalizedSkills: string[];
  experienceSignals: string[];
  piiPolicy: { directPiiStored: false; extractionMode: "allowlist_only" };
}

const literalSkills = [
  "TypeScript", "JavaScript", "React", "Next.js", "Node.js", "NestJS", "Python", "Java", "Go", "C#",
  "PostgreSQL", "SQL", "Supabase", "AWS", "GCP", "Docker", "Kubernetes", "Cloudflare", "GitHub Actions",
  "AI", "LLM", "OpenAI", "iOS", "Swift", "SwiftUI", "Unity", "WebGL", "Three.js",
];

const capabilitySkills: Array<[string, RegExp]> = [
  ["Office Administration", /事務員|事務職|一般事務|総合科|office administration|administrative/i],
  ["Academic Affairs", /教務担当|教務|学校事務|大学事務|academic affairs|student affairs/i],
  ["Qualitative Research", /聞き取り調査|生活史調査|質的調査|文献調査|interview research/i],
  ["Cross-cultural Communication", /多文化共生|異文化|文化や前提の違い|中国語・日本語・英語|cross-cultural/i],
];

export function buildSafeProfile(resumeHtml: string, policy: ProfilePolicy): SafeProfile {
  const $ = load(resumeHtml);
  $("script,style,noscript").remove();
  const text = $("body").text().replace(/\s+/g, " ");
  const normalizedSkills = [
    ...literalSkills.filter((skill) => new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(skill)}(?![A-Za-z0-9])`, "i").test(text)),
    ...capabilitySkills.filter(([, pattern]) => pattern.test(text)).map(([skill]) => skill),
  ];
  const experienceSignals = [
    ["web_product", /Web|フロントエンド|バックエンド|プロダクト/i],
    ["ai_engineering", /(?<![A-Za-z0-9])(?:AI|LLM)(?![A-Za-z0-9])|機械学習|生成AI/i],
    ["ios_engineering", /iOS|Swift|SwiftUI/i],
    ["unity_game", /Unity|ゲーム|WebGL/i],
    ["office_administration", /事務員|事務職|一般事務|総合科|office administration|administrative/i],
    ["academic_affairs", /教務担当|教務|学校事務|大学事務|academic affairs|student affairs/i],
    ["qualitative_research", /聞き取り調査|生活史調査|質的調査|文献調査|interview research/i],
    ["cross_cultural_communication", /多文化共生|異文化|文化や前提の違い|中国語・日本語・英語|cross-cultural/i],
  ].filter(([, pattern]) => (pattern as RegExp).test(text)).map(([signal]) => signal as string);
  const profile: SafeProfile = {
    schemaVersion: policy.schemaVersion,
    targetChannels: policy.targetChannels,
    rolePriorities: policy.rolePriorities,
    locations: policy.locations,
    employment: policy.employment,
    languages: policy.languages,
    visa: policy.visa,
    compensation: policy.compensation,
    normalizedSkills,
    experienceSignals,
    piiPolicy: { directPiiStored: false, extractionMode: "allowlist_only" },
  };
  assertNoDirectPii(profile);
  return profile;
}

export function assertNoDirectPii(profile: SafeProfile): void {
  const serialized = JSON.stringify(profile);
  const forbidden = [
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
    /(?:\+?81[-\s]?)?0\d{1,4}[-\s]\d{1,4}[-\s]\d{3,4}/,
    /〒?\d{3}-\d{4}/,
    /https?:\/\//i,
  ];
  if (forbidden.some((pattern) => pattern.test(serialized))) throw new Error("Safe Profile contains direct PII");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
