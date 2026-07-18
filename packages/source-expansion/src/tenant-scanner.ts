import { createHash, randomUUID } from "node:crypto";
import { GreenhouseConnector } from "../../connectors-greenhouse/src/greenhouse-connector.js";
import { HrmosConnector } from "../../connectors-hrmos/src/hrmos-connector.js";
import { AshbyConnector, LeverConnector, SmartRecruitersConnector } from "../../connectors-public-ats/src/public-ats-connectors.js";
import { PublicCareerConnector } from "../../connectors-public-career/src/public-career-connector.js";
import { WorkdayConnector } from "../../connectors-workday/src/workday-connector.js";
import { findJobPosting } from "../../connectors-schema-org/src/schema-org-connector.js";
import type { FinalizedSnapshot, JobDiscoveryLead, SourceConnector, SourceInstanceRef } from "../../contracts/src/index.js";
import { collectSnapshot } from "../../domain/src/snapshot-orchestrator.js";
import { parsePublishedDateValue } from "../../freshness/src/job-freshness.js";
import { collectPublicAtsDiscovery, publicAtsBaseUrl, type PublicAtsTenantSeed } from "../../discovery/src/public-ats-discovery.js";
import { classifyJapanLocation } from "../../discovery/src/job-discovery-service.js";
import { priorityForJob } from "../../discovery/src/sitemap-job-discovery.js";
import { detectSource } from "../../discovery/src/recruitment-entry-auditor.js";
import { DeterministicJobParser, type ParsedJob } from "../../parser/src/deterministic-job-parser.js";
import type { ClaimedTenant } from "./source-expansion-store.js";
import type { ExpansionSourceKind } from "./tenant-artifact.js";

export interface TenantScanResult {
  snapshot: FinalizedSnapshot;
  leads: JobDiscoveryLead[];
  excludedNonJapan: number;
  excludedUnknownLocation: number;
  excludedUnknownPublication: number;
  excludedOutsideWindow: number;
  latestPublishedOn: string | null;
  explicitCompanyUrl: string | null;
}

export async function scanTenant(input: {
  tenant: ClaimedTenant;
  discoverySourceId: string;
  backfillDays: number;
  fetchImplementation?: typeof fetch;
  now?: Date;
  signal: AbortSignal;
}): Promise<TenantScanResult> {
  const now = input.now ?? new Date();
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const source = sourceRef(input.tenant);
  if (isJsonAts(input.tenant.sourceKind)) {
    const seed: PublicAtsTenantSeed = {
      kind: input.tenant.sourceKind,
      tenantKey: input.tenant.tenantKey,
      ...(input.tenant.companyName === null ? {} : { companyName: input.tenant.companyName }),
      ...(input.tenant.officialReferrerUrl === null ? {} : { officialReferrerUrl: input.tenant.officialReferrerUrl }),
    };
    const collected = await collectPublicAtsDiscovery(connectorFor(input.tenant.sourceKind, fetchImplementation), source,
      seed, input.discoverySourceId, input.signal);
    const filtered = filterPublicationWindow(collected.leads, input.backfillDays, now);
    return {
      snapshot: collected.snapshot,
      ...filtered,
      excludedNonJapan: collected.excludedNonJapan,
      excludedUnknownLocation: collected.excludedUnknownLocation,
      explicitCompanyUrl: explicitCompanyUrl(collected.snapshot),
    };
  }
  const connector = connectorFor(input.tenant.sourceKind, fetchImplementation);
  const snapshot = await collectSnapshot(connector, { source, previousActiveStableKeys: new Set(), policy: {
    allowsAuthoritativeSnapshot: true, minimumPreviousActive: 5, maximumMissingRatio: 0.5, maximumMissingAbsolute: 25,
  }, now: () => now, signal: input.signal });
  if (snapshot.kind !== "authoritative") return {
    snapshot, leads: [], excludedNonJapan: 0, excludedUnknownLocation: 0,
    excludedUnknownPublication: 0, excludedOutsideWindow: 0, latestPublishedOn: null,
    explicitCompanyUrl: null,
  };
  const leads: JobDiscoveryLead[] = [];
  let excludedNonJapan = 0;
  let excludedUnknownLocation = 0;
  for (const job of snapshot.jobs) {
    const lead = await parsedCareerLead(input.tenant, input.discoverySourceId, source, job, now);
    if (lead === null) { excludedUnknownLocation += 1; continue; }
    const state = classifyJapanLocation(lead.locationText);
    if (state === "non_japan") { excludedNonJapan += 1; continue; }
    if (state === "unknown") { excludedUnknownLocation += 1; continue; }
    leads.push(lead);
  }
  return { snapshot, ...filterPublicationWindow(leads, input.backfillDays, now), excludedNonJapan, excludedUnknownLocation,
    explicitCompanyUrl: explicitCompanyUrl(snapshot) };
}

export function sourceCollectionUrl(kind: ExpansionSourceKind, tenantKey: string): string {
  if (isJsonAts(kind)) return publicAtsBaseUrl(kind, tenantKey);
  if (kind === "hrmos") return `https://hrmos.co/pages/${tenantKey}/jobs`;
  if (kind === "herp") return `https://herp.careers/v1/${tenantKey}`;
  return `https://open.talentio.com/r/1/c/${tenantKey}`;
}

function sourceRef(tenant: ClaimedTenant): SourceInstanceRef {
  return { id: randomUUID(), sourceKind: tenant.sourceKind, tenantKey: tenant.tenantKey,
    baseUrl: sourceCollectionUrl(tenant.sourceKind, tenant.tenantKey) };
}

function connectorFor(kind: ExpansionSourceKind, fetchImplementation: typeof fetch): SourceConnector {
  if (kind === "greenhouse") return new GreenhouseConnector(fetchImplementation);
  if (kind === "smartrecruiters") return new SmartRecruitersConnector(fetchImplementation);
  if (kind === "lever") return new LeverConnector(fetchImplementation);
  if (kind === "ashby") return new AshbyConnector(fetchImplementation);
  if (kind === "workday") return new WorkdayConnector(fetchImplementation, 8 * 1024 * 1024, "Japan");
  if (kind === "hrmos") return new HrmosConnector(fetchImplementation);
  return new PublicCareerConnector(kind, fetchImplementation);
}

async function parsedCareerLead(tenant: ClaimedTenant, discoverySourceId: string, source: SourceInstanceRef,
  job: FinalizedSnapshot["jobs"][number], now: Date): Promise<JobDiscoveryLead | null> {
  const parser = new DeterministicJobParser();
  const hash = createHash("sha256").update(job.raw).digest("hex");
  const parsed = await parser.parse({
    id: `source-expansion:${tenant.sourceKind}:${tenant.tenantKey}:${job.identity.stableKey}`,
    sourceJobRecordId: `source-expansion:${tenant.sourceKind}:${tenant.tenantKey}:${job.identity.stableKey}`,
    rawHash: hash,
    contentHash: hash,
    canonicalizationVersion: "source-expansion-v1",
    raw: job.raw,
    sourceUrl: job.identity.canonicalUrl,
    fetchedAt: job.response.fetchedAt,
  }, { source, localeHints: ["ja-JP", "en-JP"] });
  if (parsed.status !== "succeeded") return null;
  const structured = parsed.structured as ParsedJob;
  const title = typeof structured.title === "string" ? structured.title.trim() : "";
  const locationText = structured.locations.values.map((location) => location.addressText).filter(Boolean).join(" / ");
  if (title === "" || locationText === "") return null;
  const publishedText = structured.jobDates.published.values[0]?.value;
  const published = publishedText === undefined ? undefined : parsePublishedDateValue(publishedText);
  const companyName = schemaOrgCompany(job.raw) ?? tenant.companyName ?? tenant.tenantKey;
  return {
    discoverySourceId,
    originKind: "official_collection",
    sourceFamily: tenant.sourceKind,
    sourceKindHint: tenant.sourceKind,
    tenantKey: tenant.tenantKey,
    externalPostingId: job.identity.externalId ?? job.identity.stableKey,
    externalKey: `${tenant.sourceKind}:${tenant.tenantKey}:${job.identity.stableKey}`,
    detailUrl: job.identity.canonicalUrl,
    officialUrl: job.identity.canonicalUrl,
    companyName,
    title,
    locationText,
    priority: priorityForJob(`${title}\n${structured.descriptionText}`),
    ...(published === undefined ? {} : { published, rawPublishedText: published.value }),
    observationKey: `${tenant.sourceKind}:${tenant.tenantKey}:${job.identity.stableKey}:${now.toISOString().slice(0, 10)}`,
    payloadHash: hash,
    observedAt: job.response.fetchedAt,
    authoritative: true,
    responseMetadata: { requestedUrl: job.response.requestedUrl, status: job.response.status,
      officialReferrerUrl: tenant.officialReferrerUrl },
  };
}

function filterPublicationWindow(leads: JobDiscoveryLead[], days: number, now: Date): Pick<TenantScanResult,
  "leads" | "excludedUnknownPublication" | "excludedOutsideWindow" | "latestPublishedOn"> {
  const today = tokyoDate(now);
  const cutoff = tokyoDate(new Date(now.getTime() - (days - 1) * 86_400_000));
  let excludedUnknownPublication = 0;
  let excludedOutsideWindow = 0;
  let latestPublishedOn: string | null = null;
  const eligible = leads.filter((lead) => {
    if (lead.published === undefined) { excludedUnknownPublication += 1; return false; }
    const published = lead.published.precision === "date" ? lead.published.value
      : tokyoDate(new Date(lead.published.value));
    if (published < cutoff || published > today) { excludedOutsideWindow += 1; return false; }
    if (latestPublishedOn === null || published > latestPublishedOn) latestPublishedOn = published;
    return true;
  });
  return { leads: eligible, excludedUnknownPublication, excludedOutsideWindow, latestPublishedOn };
}

function schemaOrgCompany(raw: Uint8Array): string | null {
  try {
    const posting = findJobPosting(raw);
    const organization = isRecord(posting.hiringOrganization) ? posting.hiringOrganization : {};
    return typeof organization.name === "string" && organization.name.trim() !== "" ? organization.name.trim() : null;
  } catch { return null; }
}

function explicitCompanyUrl(snapshot: FinalizedSnapshot): string | null {
  for (const job of snapshot.jobs) {
    const candidates: unknown[] = [];
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(job.raw));
      if (isRecord(value)) {
        const company = isRecord(value.company) ? value.company : {};
        const organization = isRecord(value.hiringOrganization) ? value.hiringOrganization : {};
        candidates.push(value.companyUrl, value.organizationWebsite, company.websiteUrl, company.website, company.url,
          organization.sameAs, organization.url);
      }
    } catch {
      try {
        const posting = findJobPosting(job.raw);
        const organization = isRecord(posting.hiringOrganization) ? posting.hiringOrganization : {};
        candidates.push(organization.sameAs, organization.url);
      } catch { /* HTML without JobPosting has no ATS-declared company URL signal. */ }
    }
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      let url: URL;
      try { url = new URL(candidate); } catch { continue; }
      if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || detectSource(url.toString()) !== null) continue;
      if (/(?:greenhouse\.io|myworkdayjobs\.com|smartrecruiters\.com|lever\.co|ashbyhq\.com|hrmos\.co|herp\.careers|talentio\.com)$/i
        .test(url.hostname)) continue;
      return url.toString();
    }
  }
  return null;
}

function isJsonAts(kind: ExpansionSourceKind): kind is PublicAtsTenantSeed["kind"] {
  return kind === "greenhouse" || kind === "smartrecruiters" || kind === "lever" || kind === "ashby" || kind === "workday";
}

function tokyoDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
