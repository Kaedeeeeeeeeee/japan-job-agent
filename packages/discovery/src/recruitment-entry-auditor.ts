import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { load } from "cheerio";
import { findJobPosting } from "../../connectors-schema-org/src/schema-org-connector.js";

export type DetectedRecruitmentSourceKind = "hrmos" | "schema_org" | "greenhouse" | "herp" | "talentio"
  | "smartrecruiters" | "workday" | "jobcan" | "airwork" | "engage" | "jobposting" | "wantedly";

export interface DetectedRecruitmentSource {
  kind: DetectedRecruitmentSourceKind;
  tenantKey: string;
  url: string;
  collection: boolean;
}

export interface RecruitmentEntrypointAudit {
  requestedUrl: string;
  finalUrl: string | null;
  status: "fetched" | "blocked" | "http_error" | "network_error";
  httpStatus: number | null;
  transportSecure: boolean;
  detectedSources: DetectedRecruitmentSource[];
  candidateLinks: string[];
  error: string | null;
  fetchedAt: string;
}

type Resolver = (hostname: string) => Promise<readonly string[]>;

export async function auditRecruitmentEntrypoint(
  requestedUrl: string,
  fetchImplementation: typeof fetch = fetch,
  resolve: Resolver = resolvePublicAddresses,
  fetchedAt = new Date().toISOString(),
): Promise<RecruitmentEntrypointAudit> {
  let current: URL;
  try {
    current = new URL(requestedUrl);
  } catch {
    return failed(requestedUrl, "blocked", null, false, "invalid URL", fetchedAt);
  }
  const initiallySecure = current.protocol === "https:";
  try {
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      await assertPublicWebUrl(current, resolve);
      const response = await fetchImplementation(current, { redirect: "manual", signal: AbortSignal.timeout(30_000), headers: {
        accept: "text/html,application/xhtml+xml,application/json", "user-agent": "JapanJobAgent/0.2 (+private personal use)",
      } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (location === null) return failed(requestedUrl, "http_error", response.status, initiallySecure, "redirect omitted Location", fetchedAt);
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) return failed(requestedUrl, "http_error", response.status, initiallySecure && current.protocol === "https:", `HTTP ${response.status}`, fetchedAt, current.toString());
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > 5 * 1024 * 1024) return failed(requestedUrl, "blocked", response.status, false, "response exceeds 5 MB", fetchedAt, current.toString());
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 5 * 1024 * 1024) return failed(requestedUrl, "blocked", response.status, false, "response exceeds 5 MB", fetchedAt, current.toString());
      const html = new TextDecoder().decode(bytes);
      const links = extractCandidateLinks(html, current);
      const detected = new Map<string, DetectedRecruitmentSource>();
      for (const source of [detectSource(current.toString()), ...links.map(detectSource)]) {
        if (source !== null) detected.set(`${source.kind}:${source.tenantKey}:${source.url}`, source);
      }
      try {
        findJobPosting(bytes);
        const source: DetectedRecruitmentSource = { kind: "schema_org", tenantKey: stableRecordKey(current), url: current.toString(), collection: false };
        detected.set(`${source.kind}:${source.tenantKey}:${source.url}`, source);
      } catch {
        // Absence of JobPosting is an expected unknown, not an audit error.
      }
      return {
        requestedUrl,
        finalUrl: current.toString(),
        status: "fetched",
        httpStatus: response.status,
        transportSecure: initiallySecure && current.protocol === "https:",
        detectedSources: [...detected.values()],
        candidateLinks: links,
        error: null,
        fetchedAt,
      };
    }
    return failed(requestedUrl, "blocked", null, false, "too many redirects", fetchedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failed(requestedUrl, /private|protocol|credential/i.test(message) ? "blocked" : "network_error", null,
      initiallySecure && current.protocol === "https:", message, fetchedAt, current.toString());
  }
}

export function detectSource(value: string): DetectedRecruitmentSource | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname.toLowerCase();
  let match: RegExpMatchArray | null;
  if (host === "hrmos.co" && (match = url.pathname.match(/^\/pages\/([^/]+)(?:\/jobs(?:\/([^/]+))?)?/)) !== null) {
    const tenant = match[1];
    if (tenant === undefined) return null;
    return { kind: "hrmos", tenantKey: tenant, url: `https://hrmos.co/pages/${tenant}/jobs`, collection: true };
  }
  if (host === "public.n-ats.hrmos.co" && (match = url.pathname.match(/^\/([^/]+)\/jobs\/([^/]+)/)) !== null) {
    return { kind: "schema_org", tenantKey: `n-ats:${match[1]}:${match[2]}`, url: url.toString(), collection: false };
  }
  if ((host === "boards-api.greenhouse.io" || host === "job-boards.greenhouse.io") && (match = url.pathname.match(/\/(?:v1\/boards\/)?([^/]+)\/jobs/)) !== null) {
    return { kind: "greenhouse", tenantKey: match[1] ?? "", url: `https://boards-api.greenhouse.io/v1/boards/${match[1]}/jobs`, collection: true };
  }
  if (host === "herp.careers" && (match = url.pathname.match(/^\/v1\/([^/]+)/)) !== null) {
    return { kind: "herp", tenantKey: match[1] ?? "", url: `https://herp.careers/v1/${match[1]}`, collection: true };
  }
  if (host === "open.talentio.com" && (match = url.pathname.match(/^\/r\/\d+\/c\/([^/]+)(?:\/homes\/\d+)?/)) !== null) {
    const home = url.pathname.match(/^\/r\/\d+\/c\/[^/]+\/homes\/\d+/)?.[0];
    return { kind: "talentio", tenantKey: match[1] ?? "", url: home === undefined
      ? `https://open.talentio.com/r/1/c/${match[1]}` : `https://open.talentio.com${home}`, collection: true };
  }
  if (host === "jobs.smartrecruiters.com" && (match = url.pathname.match(/^\/([^/]+)/)) !== null) {
    return { kind: "smartrecruiters", tenantKey: match[1] ?? "", url: `https://jobs.smartrecruiters.com/${match[1]}`, collection: true };
  }
  if (host.endsWith("myworkdayjobs.com")) {
    return { kind: "workday", tenantKey: host, url: url.origin + url.pathname, collection: true };
  }
  if (host === "recruit.jobcan.jp" && (match = url.pathname.match(/^\/([^/]+)(?:\/job_offers\/([^/]+))?/)) !== null) {
    return { kind: "jobcan", tenantKey: match[1] ?? "", url: `https://recruit.jobcan.jp/${match[1]}`, collection: true };
  }
  if (host === "arwrk.net" && (match = url.pathname.match(/^\/recruit\/([^/]+)/)) !== null) {
    return { kind: "airwork", tenantKey: match[1] ?? "", url: `https://arwrk.net/recruit/${match[1]}`, collection: true };
  }
  if (host === "en-gage.net" && (match = url.pathname.match(/^\/([^/]+)/)) !== null) {
    return { kind: "engage", tenantKey: match[1] ?? "", url: `https://en-gage.net/${match[1]}/`, collection: true };
  }
  if (host.endsWith(".jbplt.jp")) {
    return { kind: "jobposting", tenantKey: host.split(".")[0] ?? host, url: url.origin, collection: true };
  }
  if (host === "www.wantedly.com" && (match = url.pathname.match(/^\/companies\/([^/]+)/)) !== null) {
    return { kind: "wantedly", tenantKey: match[1] ?? "", url: `https://www.wantedly.com/companies/${match[1]}`, collection: true };
  }
  return null;
}

async function assertPublicWebUrl(url: URL, resolve: Resolver): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("unsupported protocol");
  if (url.username !== "" || url.password !== "") throw new Error("URL credentials are forbidden");
  const addresses = isIP(url.hostname) === 0 ? await resolve(url.hostname) : [url.hostname];
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new Error(`Host ${url.hostname} resolves to a private address`);
}

function extractCandidateLinks(html: string, base: URL): string[] {
  const $ = load(html);
  const output = new Set<string>();
  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    if (href === undefined) return;
    let url: URL;
    try { url = new URL(href, base); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol)) return;
    const label = `${$(element).text()} ${url.pathname}`;
    if (detectSource(url.toString()) !== null || /job|career|recruit|採用|求人|募集|entry/i.test(label)) output.add(url.toString());
  });
  return [...output].slice(0, 100);
}

function stableRecordKey(url: URL): string {
  return `${url.hostname}${url.pathname}`.replace(/[^a-zA-Z0-9._-]+/g, ":");
}

function failed(requestedUrl: string, status: RecruitmentEntrypointAudit["status"], httpStatus: number | null,
  transportSecure: boolean, error: string, fetchedAt: string, finalUrl: string | null = null): RecruitmentEntrypointAudit {
  return { requestedUrl, finalUrl, status, httpStatus, transportSecure, detectedSources: [], candidateLinks: [], error, fetchedAt };
}

async function resolvePublicAddresses(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : undefined);
  if (ipv4 === undefined) return false;
  const [a = 0, b = 0] = ipv4.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
