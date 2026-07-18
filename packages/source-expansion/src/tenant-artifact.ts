import { z } from "zod";
import { detectSource } from "../../discovery/src/recruitment-entry-auditor.js";

export const expansionSourceKindSchema = z.enum([
  "greenhouse", "workday", "smartrecruiters", "lever", "ashby", "hrmos", "herp", "talentio",
]);
export type ExpansionSourceKind = z.infer<typeof expansionSourceKindSchema>;

export const tenantCandidateArtifactItemSchema = z.object({
  sourceKind: expansionSourceKindSchema,
  tenantKey: z.string().min(1),
  sourceUrl: z.url(),
  companyName: z.string().min(1).optional(),
  discoveredVia: z.enum(["github_code_search", "jpx", "jetro", "configured_seed", "operator"]),
  repositoryUrl: z.url().optional(),
  repositoryHomepage: z.url().optional(),
  repositoryCname: z.string().min(1).optional(),
  officialReferrerUrl: z.url().optional(),
  officialReferrerBasis: z.enum([
    "jpx", "jetro", "ats_company_url", "repository_cname", "repository_homepage", "operator_review",
  ]).optional(),
  japanSignalBasis: z.enum(["jpx_name_match", "jetro_name_match", "japan_job_observed"]).optional(),
  japanSignalCompanyName: z.string().min(1).optional(),
  evidence: z.record(z.string(), z.unknown()).default({}),
});
export type TenantCandidateArtifactItem = z.infer<typeof tenantCandidateArtifactItemSchema>;

export const tenantCandidateArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime(),
  generator: z.string().min(1),
  requestBudget: z.number().int().min(0).max(300),
  requestsUsed: z.number().int().min(0).max(300),
  metadataRequestsUsed: z.number().int().nonnegative().optional(),
  truncated: z.boolean(),
  candidates: z.array(tenantCandidateArtifactItemSchema),
  summary: z.record(z.string(), z.number().int().nonnegative()),
});
export type TenantCandidateArtifact = z.infer<typeof tenantCandidateArtifactSchema>;

const HOSTS: Readonly<Record<ExpansionSourceKind, string>> = {
  greenhouse: "greenhouse.io",
  workday: "myworkdayjobs.com",
  smartrecruiters: "smartrecruiters.com",
  lever: "jobs.lever.co",
  ashby: "jobs.ashbyhq.com",
  hrmos: "hrmos.co/pages",
  herp: "herp.careers/v1",
  talentio: "open.talentio.com/r/1/c",
};

const QUERY_SHARDS = ["extension:html", "extension:json", "extension:js", "extension:ts"] as const;

export function githubTenantQueries(): string[] {
  return (Object.entries(HOSTS) as Array<[ExpansionSourceKind, string]>).flatMap(([kind, host]) => {
    const shards = kind === "workday" ? QUERY_SHARDS : QUERY_SHARDS.slice(0, 3);
    return shards.map((shard) => `\"${host}\" in:file ${shard}`);
  }).slice(0, 30);
}

export function rotateTenantQueries(queries: string[], seed: number): string[] {
  if (queries.length === 0 || !Number.isSafeInteger(seed)) return [...queries];
  const offset = ((seed % queries.length) + queries.length) % queries.length;
  return [...queries.slice(offset), ...queries.slice(0, offset)];
}

export function candidatesFromText(
  text: string,
  evidence: Pick<TenantCandidateArtifactItem, "repositoryUrl" | "repositoryHomepage" | "repositoryCname"> = {},
): TenantCandidateArtifactItem[] {
  const urls = extractUrls(text);
  const candidates: TenantCandidateArtifactItem[] = [];
  for (const rawUrl of urls) {
    const source = detectSource(rawUrl);
    if (source === null || !expansionSourceKindSchema.safeParse(source.kind).success || source.tenantKey === "") continue;
    const sourceKind = source.kind as ExpansionSourceKind;
    const official = corporateReference(evidence);
    candidates.push({
      sourceKind,
      tenantKey: source.tenantKey,
      sourceUrl: source.url,
      discoveredVia: "github_code_search",
      ...defined(evidence),
      ...official,
      evidence: { matchedUrl: rawUrl },
    });
  }
  return deduplicateArtifactCandidates(candidates);
}

export function deduplicateArtifactCandidates(values: TenantCandidateArtifactItem[]): TenantCandidateArtifactItem[] {
  const output = new Map<string, TenantCandidateArtifactItem>();
  for (const raw of values) {
    const value = tenantCandidateArtifactItemSchema.parse(raw);
    const key = `${value.sourceKind}:${value.tenantKey.toLowerCase()}`;
    const current = output.get(key);
    if (current === undefined) {
      output.set(key, value);
      continue;
    }
    output.set(key, {
      ...current,
      ...(current.companyName === undefined && value.companyName !== undefined ? { companyName: value.companyName } : {}),
      ...(current.repositoryUrl === undefined && value.repositoryUrl !== undefined ? { repositoryUrl: value.repositoryUrl } : {}),
      ...(current.repositoryHomepage === undefined && value.repositoryHomepage !== undefined
        ? { repositoryHomepage: value.repositoryHomepage } : {}),
      ...(current.repositoryCname === undefined && value.repositoryCname !== undefined ? { repositoryCname: value.repositoryCname } : {}),
      ...(current.officialReferrerUrl === undefined && value.officialReferrerUrl !== undefined
        ? { officialReferrerUrl: value.officialReferrerUrl, officialReferrerBasis: value.officialReferrerBasis } : {}),
      ...(current.japanSignalBasis === undefined && value.japanSignalBasis !== undefined
        ? { japanSignalBasis: value.japanSignalBasis, japanSignalCompanyName: value.japanSignalCompanyName } : {}),
      evidence: { ...current.evidence, ...value.evidence },
    });
  }
  return [...output.values()].sort((left, right) => left.sourceKind.localeCompare(right.sourceKind)
    || left.tenantKey.localeCompare(right.tenantKey));
}

export function matchCompanyNameSignal(haystack: string, names: string[]): string | undefined {
  const normalizedHaystack = normalizeCompanyNameSignal(haystack);
  return names.filter((name) => {
    const normalized = normalizeCompanyNameSignal(name);
    return normalized.length >= 4 && normalizedHaystack.includes(normalized);
  }).sort((left, right) => normalizeCompanyNameSignal(right).length - normalizeCompanyNameSignal(left).length)[0];
}

export function normalizeCompanyNameSignal(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/(?:co\.?|ltd\.?|inc\.?|corp\.?|corporation|company|株式会社)/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function extractUrls(text: string): string[] {
  const decoded = text.replaceAll("\\/", "/").replaceAll("&amp;", "&").replaceAll("&quot;", '"');
  return [...new Set([...decoded.matchAll(/https?:\/\/[^\s"'<>\\)\]]+/gi)].map((match) =>
    (match[0] ?? "").replace(/[.,;:]+$/, "")))];
}

function corporateReference(
  evidence: Pick<TenantCandidateArtifactItem, "repositoryHomepage" | "repositoryCname">,
): Pick<TenantCandidateArtifactItem, "officialReferrerUrl" | "officialReferrerBasis"> {
  if (evidence.repositoryHomepage !== undefined && detectSource(evidence.repositoryHomepage) === null) {
    return { officialReferrerUrl: evidence.repositoryHomepage, officialReferrerBasis: "repository_homepage" };
  }
  if (evidence.repositoryCname !== undefined) {
    const host = evidence.repositoryCname.trim().replace(/^https?:\/\//, "").split("/")[0];
    if (host !== undefined && /^[A-Za-z0-9.-]+$/.test(host)) {
      const url = `https://${host}/`;
      if (detectSource(url) === null) return { officialReferrerUrl: url, officialReferrerBasis: "repository_cname" };
    }
  }
  return {};
}

function defined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as Partial<T>;
}
