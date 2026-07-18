import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { JobDateValue, JobDiscoveryLead } from "../../contracts/src/index.js";
import { DeterministicJobParser, type ParsedJob } from "../../parser/src/deterministic-job-parser.js";
import { parsePublishedDateValue } from "../../freshness/src/job-freshness.js";

export interface SitemapEntry {
  url: string;
  lastModified?: string;
}

export interface ParsedListingPage {
  leads: JobDiscoveryLead[];
  nextPageUrls: string[];
}

export function parseSitemapEntries(input: Uint8Array, expectedHost: string): SitemapEntry[] {
  const $ = load(new TextDecoder().decode(input), { xmlMode: true });
  const entries: SitemapEntry[] = [];
  $("url").each((_index, element) => {
    const rawUrl = $(element).find("loc").first().text().trim();
    if (rawUrl === "") return;
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.hostname !== expectedHost) return;
    const lastModified = $(element).find("lastmod").first().text().trim();
    entries.push({ url: url.toString(), ...(lastModified === "" ? {} : { lastModified }) });
  });
  return entries;
}

export function parseSitemapIndex(input: Uint8Array, expectedHost: string): string[] {
  const $ = load(new TextDecoder().decode(input), { xmlMode: true });
  return $("sitemap > loc").toArray().flatMap((element) => {
    const raw = $(element).text().trim();
    if (raw === "") return [];
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === expectedHost ? [url.toString()] : [];
  });
}

export function parseYoloListingPage(
  input: Uint8Array,
  discoverySourceId: string,
  collectionUrl: string,
  observedAt: string,
): ParsedListingPage {
  const html = new TextDecoder().decode(input);
  const jobs = extractJobPostings(html);
  const leads = jobs.flatMap((job) => {
    const url = jobUrl(job);
    const externalId = url?.pathname.match(/^\/ja\/recruit\/job\/details\/(\d+)$/)?.[1];
    if (url === null || externalId === undefined || url.hostname !== "www.yolo-japan.com") return [];
    const lead = leadFromJobPosting(job, {
      discoverySourceId,
      sourceFamily: "yolo_japan",
      tenantKey: "yolo-japan",
      externalId,
      detailUrl: url.toString(),
      originKind: "aggregator_lead",
      authoritative: false,
      observationKey: `yolo:${new URL(collectionUrl).pathname}:${externalId}:${observedAt.slice(0, 10)}`,
      observedAt,
      collectionUrl,
    });
    return lead === null ? [] : [lead];
  });
  const $ = load(html);
  const nextPageUrls = $("nav.pagination a[href]").toArray().flatMap((element) => {
    const href = $(element).attr("href");
    if (href === undefined) return [];
    const url = new URL(href, collectionUrl);
    return url.hostname === "www.yolo-japan.com" && /^\/ja\/sitemap\/(job-category|area)\//.test(url.pathname)
      ? [url.toString()] : [];
  });
  return { leads, nextPageUrls: [...new Set(nextPageUrls)] };
}

export function parseEngageDetail(
  input: Uint8Array,
  discoverySourceId: string,
  detailUrl: string,
  sitemapUrl: string,
  sitemapLastModified: string | undefined,
  observedAt: string,
): JobDiscoveryLead | null {
  const jobs = extractJobPostings(new TextDecoder().decode(input));
  const externalId = new URL(detailUrl).pathname.match(/^\/user\/search\/desc\/(\d+)\/?$/)?.[1];
  if (externalId === undefined) return null;
  const job = jobs.find((candidate) => jobUrl(candidate)?.pathname.includes(`/${externalId}`)) ?? jobs[0];
  if (job === undefined) return null;
  return leadFromJobPosting(job, {
    discoverySourceId,
    sourceFamily: "engage",
    tenantKey: "engage-search",
    externalId,
    detailUrl,
    originKind: "aggregator_lead",
    authoritative: false,
    observationKey: `engage:detail:${externalId}:${sitemapLastModified ?? "undated"}:${observedAt.slice(0, 10)}`,
    observedAt,
    collectionUrl: sitemapUrl,
  });
}

export async function parseTalentioDetail(
  input: Uint8Array,
  discoverySourceId: string,
  detailUrl: string,
  sitemapLastModified: string | undefined,
  observedAt: string,
): Promise<JobDiscoveryLead | null> {
  const identity = new URL(detailUrl).pathname.match(/^\/r\/1\/c\/([^/]+)\/pages\/(\d+)\/?$/);
  const tenantKey = identity?.[1];
  const externalId = identity?.[2];
  if (tenantKey === undefined || externalId === undefined) return null;
  const parser = new DeterministicJobParser();
  const parsed = await parser.parse({
    id: `discovery:${tenantKey}:${externalId}`,
    sourceJobRecordId: `discovery:${tenantKey}:${externalId}`,
    rawHash: sha256(input),
    contentHash: sha256(input),
    canonicalizationVersion: "discovery-v1",
    raw: input,
    sourceUrl: detailUrl,
    fetchedAt: observedAt,
  }, {
    source: { id: `discovery:${tenantKey}`, sourceKind: "talentio", tenantKey, baseUrl: "https://open.talentio.com" },
    localeHints: ["ja-JP"],
  });
  if (parsed.status !== "succeeded") return null;
  const structured = parsed.structured as ParsedJob;
  const title = typeof structured.title === "string" ? structured.title.trim() : "";
  const locationText = structured.locations.values.map((location) => location.addressText).filter(Boolean).join(" / ");
  if (title === "" || locationText === "") return null;
  const html = new TextDecoder().decode(input);
  const $ = load(html);
  const companyName = companyFromTalentio($('meta[property="og:title"]').attr("content") ?? $("title").text(), tenantKey);
  const companyUrl = talentioCorporateUrl($('[data-react-props]').first().attr("data-react-props"));
  const homeUrl = talentioHomeUrl($, tenantKey);
  const published = dateValue(structured.jobDates.published.values[0]?.value);
  return {
    discoverySourceId,
    originKind: "official_collection",
    sourceFamily: "talentio",
    sourceKindHint: "talentio",
    tenantKey,
    externalPostingId: externalId,
    externalKey: `talentio:${tenantKey}:${externalId}`,
    detailUrl,
    officialUrl: detailUrl,
    companyName,
    title,
    locationText,
    priority: priorityForJob(`${title}\n${structured.descriptionText}`),
    ...(published === undefined ? {} : { published, rawPublishedText: published.value }),
    observationKey: `talentio:sitemap:${externalId}:${sitemapLastModified ?? "undated"}`,
    payloadHash: sha256(input),
    observedAt,
    authoritative: true,
    responseMetadata: { sitemapLastModified: sitemapLastModified ?? null, companyUrl, homeUrl },
  };
}

export function priorityForJob(input: string): JobDiscoveryLead["priority"] {
  if (/software|engineer|developer|product|web|AI|machine learning|data|e.?commerce|IT|システム|エンジニア|開発|プロダクト/i.test(input)) return "p0";
  if (/consult|human resources|recruit|talent acquisition|people operations|人事|採用|コンサル/i.test(input)) return "p1";
  if (/介護|特定技能|specified skilled worker/i.test(input)) return "p3";
  return "p2";
}

interface JobPostingLeadOptions {
  discoverySourceId: string;
  sourceFamily: string;
  tenantKey: string;
  externalId: string;
  detailUrl: string;
  originKind: "aggregator_lead" | "search_index";
  authoritative: false;
  observationKey: string;
  observedAt: string;
  collectionUrl: string;
}

function leadFromJobPosting(job: Record<string, unknown>, options: JobPostingLeadOptions): JobDiscoveryLead | null {
  const title = text(job.title)?.trim() ?? "";
  const company = isObject(job.hiringOrganization) ? text(job.hiringOrganization.name)?.trim() ?? "" : "";
  const locationText = jobLocationText(job);
  if (title === "" || company === "" || locationText === "") return null;
  const published = dateValue(text(job.datePosted));
  const payload = new TextEncoder().encode(JSON.stringify(job));
  return {
    discoverySourceId: options.discoverySourceId,
    originKind: options.originKind,
    sourceFamily: options.sourceFamily,
    tenantKey: options.tenantKey,
    externalPostingId: options.externalId,
    externalKey: `${options.sourceFamily}:${options.externalId}`,
    detailUrl: options.detailUrl,
    companyName: company,
    title,
    locationText,
    priority: priorityForJob(`${title}\n${text(job.description) ?? ""}`),
    ...(published === undefined ? {} : { published, rawPublishedText: text(job.datePosted) ?? published.value }),
    observationKey: options.observationKey,
    payloadHash: sha256(payload),
    observedAt: options.observedAt,
    authoritative: options.authoritative,
    responseMetadata: { collectionUrl: options.collectionUrl, directApply: job.directApply ?? null },
  };
}

function extractJobPostings(html: string): Record<string, unknown>[] {
  const $ = load(html);
  const output: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_index, element) => {
    const raw = $(element).text().trim();
    if (raw === "") return;
    try {
      collectJobPostings(JSON.parse(raw) as unknown, output);
    } catch {
      // One malformed JSON-LD block must not discard valid blocks from the same listing page.
    }
  });
  return output;
}

function collectJobPostings(value: unknown, output: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectJobPostings(item, output));
    return;
  }
  if (!isObject(value)) return;
  const type = value["@type"];
  if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) output.push(value);
  if (Array.isArray(value["@graph"])) collectJobPostings(value["@graph"], output);
  if (Array.isArray(value.itemListElement)) collectJobPostings(value.itemListElement, output);
  if (isObject(value.item)) collectJobPostings(value.item, output);
}

function jobLocationText(job: Record<string, unknown>): string {
  const values = array(job.jobLocation).flatMap((location) => locationValue(location));
  const applicant = array(job.applicantLocationRequirements).flatMap((location) => locationValue(location));
  const remote = text(job.jobLocationType)?.toUpperCase() === "TELECOMMUTE";
  const joined = [...values, ...applicant].filter(Boolean).join(" / ");
  if (remote && /JP|Japan|日本/i.test(joined)) return `Japan remote / ${joined}`;
  return joined;
}

function locationValue(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!isObject(value)) return [];
  const address = isObject(value.address) ? value.address : value;
  return [
    text(address.addressCountry), text(address.addressRegion), text(address.addressLocality), text(address.streetAddress),
  ].filter((item): item is string => item !== undefined && item.trim() !== "");
}

function jobUrl(job: Record<string, unknown>): URL | null {
  const raw = text(job.url);
  if (raw === undefined) return null;
  try { return new URL(raw); } catch { return null; }
}

function companyFromTalentio(value: string, fallback: string): string {
  const parts = value.split("/").map((part) => part.trim()).filter(Boolean);
  return parts.at(-1)?.replace(/^募集(一覧|詳細)\s*/, "").trim() || fallback;
}

function talentioCorporateUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isObject(value) || !isObject(value.openAtsCompany)) return null;
    const url = text(value.openAtsCompany.openAtsLinkUrl);
    return url === undefined || url === "" ? null : url;
  } catch { return null; }
}

function talentioHomeUrl($: ReturnType<typeof load>, tenantKey: string): string | null {
  const prefix = `/r/1/c/${tenantKey}/homes/`;
  const href = $("a[href]").toArray().map((element) => $(element).attr("href"))
    .find((value): value is string => value !== undefined && new URL(value, "https://open.talentio.com").pathname.startsWith(prefix));
  return href === undefined ? null : new URL(href, "https://open.talentio.com").toString();
}

function dateValue(raw: string | undefined): JobDateValue | undefined {
  return raw === undefined ? undefined : parsePublishedDateValue(raw);
}

function array(value: unknown): unknown[] { return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]; }
function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
