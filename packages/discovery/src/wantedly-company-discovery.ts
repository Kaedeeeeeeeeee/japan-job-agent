import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { JobDiscoveryLead } from "../../contracts/src/index.js";
import { parsePublishedDateValue } from "../../freshness/src/job-freshness.js";

export interface WantedlyCompanySeed {
  tenantKey: string;
  companyName?: string;
}

export interface WantedlyCompanyPageResult {
  leads: JobDiscoveryLead[];
  companyName: string;
  projectCount: number;
  normalProjectCount: number;
  rawHash: string;
}

export function parseWantedlyCompanyPage(
  bytes: Uint8Array,
  seed: WantedlyCompanySeed,
  discoverySourceId: string,
  pageUrl: string,
  observedAt: string,
): WantedlyCompanyPageResult {
  const $ = load(new TextDecoder().decode(bytes));
  const raw = $("#ssr-app-data").text();
  if (raw === "") throw new Error("Wantedly page omitted #ssr-app-data");
  const root = record(JSON.parse(raw));
  const body = record(root.body);
  const company = record(body.company);
  const companyPath = text(company.company_path);
  if (companyPath !== `/companies/${seed.tenantKey}`) {
    throw new Error(`Wantedly tenant mismatch: expected ${seed.tenantKey}, received ${companyPath ?? "unknown"}`);
  }
  const projects = Array.isArray(body.projects) ? body.projects.filter(isRecord) : [];
  const declaredCount = integer(company.project_count);
  if (declaredCount === null || declaredCount !== projects.length) {
    throw new Error(`Wantedly page was incomplete: declared ${declaredCount ?? "unknown"}, loaded ${projects.length}`);
  }
  const companyName = nonEmptyText(company.name) ?? seed.companyName ?? seed.tenantKey;
  const normalProjects = projects.filter((project) => project.category === "normal");
  const leads: JobDiscoveryLead[] = [];
  for (const project of normalProjects) {
    const id = integer(project.id);
    const title = nonEmptyText(project.title);
    const detailUrl = safeProjectUrl(project.project_url, id);
    const locationText = nonEmptyText(project.location) ?? "";
    const publishedRaw = nonEmptyText(project.published_at);
    const published = publishedRaw === null ? undefined : parsePublishedDateValue(publishedRaw);
    if (id === null || title === null || detailUrl === null || published === undefined) continue;
    const payload = JSON.stringify({ id, title, locationText, publishedAt: publishedRaw,
      occupation: project.localized_occupation_type, hiringTypes: project.hiring_type_and_labels });
    leads.push({
      discoverySourceId,
      originKind: "official_collection",
      sourceFamily: "wantedly",
      tenantKey: seed.tenantKey,
      externalPostingId: String(id),
      externalKey: `wantedly:${id}`,
      detailUrl,
      officialUrl: detailUrl,
      companyName,
      title,
      locationText,
      priority: priority(title, payload),
      published,
      rawPublishedText: publishedRaw!,
      observationKey: `wantedly:${seed.tenantKey}:${id}:${observedAt.slice(0, 10)}`,
      payloadHash: createHash("sha256").update(payload).digest("hex"),
      observedAt,
      authoritative: true,
      responseMetadata: { collectionKind: "wantedly_public_company_projects", collectionUrl: pageUrl, projectId: id,
        storesFullContent: false, termsBoundary: "robots-permitted-public-metadata-only" },
    });
  }
  return {
    leads,
    companyName,
    projectCount: projects.length,
    normalProjectCount: normalProjects.length,
    rawHash: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function wantedlyRobotsAllowsCompanyProjects(bytes: Uint8Array, path: string): boolean {
  if (!/^\/companies\/[A-Za-z0-9._-]+\/projects$/.test(path)) return false;
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; pattern: string }> }> = [];
  let group: (typeof groups)[number] | undefined;
  for (const rawLine of new TextDecoder().decode(bytes).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (line === "") continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") {
      if (group === undefined || group.rules.length > 0) {
        group = { agents: [], rules: [] };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && group !== undefined && value !== "") {
      group.rules.push({ allow: key === "allow", pattern: value });
    }
  }
  const rules = groups.filter((candidate) => candidate.agents.includes("*"))
    .flatMap((candidate) => candidate.rules)
    .filter((rule) => robotsPattern(rule.pattern).test(path))
    .sort((left, right) => right.pattern.length - left.pattern.length || Number(right.allow) - Number(left.allow));
  return rules[0]?.allow ?? true;
}

function robotsPattern(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const raw = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = raw.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

function safeProjectUrl(value: unknown, id: number | null): string | null {
  if (id === null || typeof value !== "string") return null;
  try {
    const url = new URL(value, "https://www.wantedly.com");
    return url.protocol === "https:" && url.hostname === "www.wantedly.com" && url.pathname === `/projects/${id}`
      ? `https://www.wantedly.com/projects/${id}` : null;
  } catch { return null; }
}

function priority(title: string, payload: string): "p0" | "p1" | "p2" | "p3" {
  const value = `${title} ${payload}`;
  if (/software|engineer|developer|product|web|AI|machine learning|data|IT|システム|エンジニア|開発|プロダクト/i.test(value)) return "p0";
  if (/consult|human resources|recruit|talent|people operations|人事|採用|コンサル/i.test(value)) return "p1";
  return "p2";
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Wantedly SSR payload shape changed");
  return value;
}

function text(value: unknown): string | null { return typeof value === "string" ? value : null; }
function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
function integer(value: unknown): number | null { return Number.isInteger(value) ? value as number : null; }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
