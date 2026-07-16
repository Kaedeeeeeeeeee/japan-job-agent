import {
  auditRecruitmentEntrypoint,
  detectSource,
  type DetectedRecruitmentSource,
  type DetectedRecruitmentSourceKind,
  type RecruitmentEntrypointAudit,
} from "./recruitment-entry-auditor.js";

export interface OfficialSourceBacklinkVerification {
  verified: boolean;
  corporateUrl: string;
  evidencePageUrl: string | null;
  detectedSource: DetectedRecruitmentSource | null;
  audits: RecruitmentEntrypointAudit[];
  reason: string;
}

export async function verifyOfficialSourceBacklink(
  corporateUrl: string,
  expectedKind: DetectedRecruitmentSourceKind,
  expectedTenantKey: string,
  fetchImplementation: typeof fetch = fetch,
  maximumPages = 12,
): Promise<OfficialSourceBacklinkVerification> {
  const secureCorporateUrl = preferHttps(corporateUrl);
  let root: URL;
  try { root = new URL(secureCorporateUrl); } catch {
    return failure(corporateUrl, [], "invalid_corporate_url");
  }
  if (root.protocol !== "https:") return failure(corporateUrl, [], "corporate_url_not_https");
  if (detectSource(root.toString()) !== null) return failure(secureCorporateUrl, [], "corporate_url_is_recruitment_platform");
  const queue = [root.toString()];
  const visited = new Set<string>();
  const audits: RecruitmentEntrypointAudit[] = [];
  while (queue.length > 0 && audits.length < maximumPages) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    const audit = await auditRecruitmentEntrypoint(url, fetchImplementation);
    audits.push(audit);
    const detected = audit.detectedSources.find((source) =>
      source.kind === expectedKind && source.tenantKey.toLowerCase() === expectedTenantKey.toLowerCase());
    if (audit.status === "fetched" && audit.transportSecure && detected !== undefined) {
      return { verified: true, corporateUrl: secureCorporateUrl, evidencePageUrl: audit.finalUrl,
        detectedSource: detected, audits, reason: "verified_official_domain_backlink" };
    }
    for (const candidate of prioritizeLinks(audit.candidateLinks)) {
      if (visited.has(candidate) || !sameCorporateSite(root, candidate)) continue;
      queue.push(candidate);
    }
  }
  const fetched = audits.some((audit) => audit.status === "fetched");
  return failure(secureCorporateUrl, audits, fetched ? "ats_backlink_not_found" : "corporate_site_unreachable");
}

function prioritizeLinks(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => linkPriority(right) - linkPriority(left) || left.localeCompare(right));
}

function linkPriority(value: string): number {
  if (/recruit\/search|career\/jobs|採用.*募集/i.test(value)) return 3;
  if (/recruit|career|採用|求人|募集/i.test(value)) return 2;
  if (/job|search/i.test(value)) return 1;
  return 0;
}

function sameCorporateSite(root: URL, candidate: string): boolean {
  let url: URL;
  try { url = new URL(candidate); } catch { return false; }
  if (url.protocol !== "https:") return false;
  const rootHost = root.hostname.toLowerCase().replace(/^www\./, "");
  const candidateHost = url.hostname.toLowerCase().replace(/^www\./, "");
  return candidateHost === rootHost || candidateHost.endsWith(`.${rootHost}`) || rootHost.endsWith(`.${candidateHost}`);
}

function preferHttps(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "http:") url.protocol = "https:";
    return url.toString();
  } catch { return value; }
}

function failure(corporateUrl: string, audits: RecruitmentEntrypointAudit[], reason: string): OfficialSourceBacklinkVerification {
  return { verified: false, corporateUrl, evidencePageUrl: null, detectedSource: null, audits, reason };
}
