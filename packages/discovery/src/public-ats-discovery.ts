import { createHash } from "node:crypto";
import type {
  FinalizedSnapshot,
  JobDiscoveryLead,
  SourceConnector,
  SourceInstanceRef,
  SourceKind,
} from "../../contracts/src/index.js";
import { collectSnapshot } from "../../domain/src/snapshot-orchestrator.js";
import { parsePublishedDateValue } from "../../freshness/src/job-freshness.js";
import { classifyJapanLocation } from "./job-discovery-service.js";

export interface PublicAtsTenantSeed {
  kind: "greenhouse" | "smartrecruiters" | "lever" | "ashby" | "workday";
  tenantKey: string;
  companyName?: string;
  officialReferrerUrl?: string;
}

export interface PublicAtsDiscoveryResult {
  snapshot: FinalizedSnapshot;
  leads: JobDiscoveryLead[];
  excludedNonJapan: number;
  excludedUnknownLocation: number;
}

export async function collectPublicAtsDiscovery(
  connector: SourceConnector,
  source: SourceInstanceRef,
  seed: PublicAtsTenantSeed,
  discoverySourceId: string,
  signal: AbortSignal,
): Promise<PublicAtsDiscoveryResult> {
  const snapshot = await collectSnapshot(connector, {
    source,
    previousActiveStableKeys: new Set(),
    policy: {
      allowsAuthoritativeSnapshot: true,
      minimumPreviousActive: 5,
      maximumMissingRatio: 0.5,
      maximumMissingAbsolute: 25,
    },
    now: () => new Date(),
    signal,
  });
  if (snapshot.kind !== "authoritative") return { snapshot, leads: [], excludedNonJapan: 0, excludedUnknownLocation: 0 };
  const leads: JobDiscoveryLead[] = [];
  let excludedNonJapan = 0;
  let excludedUnknownLocation = 0;
  for (const listedJob of snapshot.jobs) {
    const listedValue = parseObject(listedJob.raw);
    const listedLocation = publicAtsLocation(seed.kind, listedValue);
    const listedLocationState = classifyJapanLocation(listedLocation);
    if (listedLocationState === "non_japan") {
      excludedNonJapan += 1;
      continue;
    }
    if (listedLocationState === "unknown") {
      excludedUnknownLocation += 1;
      continue;
    }
    const job = seed.kind === "workday" ? await connector.fetchRecord(listedJob.identity, signal) : listedJob;
    const value = parseObject(job.raw);
    const locationText = publicAtsLocation(seed.kind, value);
    const locationState = classifyJapanLocation(locationText);
    if (locationState === "non_japan") {
      excludedNonJapan += 1;
      continue;
    }
    if (locationState === "unknown") {
      excludedUnknownLocation += 1;
      continue;
    }
    const title = publicAtsTitle(seed.kind, value);
    if (title === null) continue;
    const companyName = publicAtsCompany(seed.kind, value) ?? seed.companyName ?? seed.tenantKey;
    const published = publicAtsPublished(seed.kind, value);
    const observedAt = job.response.fetchedAt;
    leads.push({
      discoverySourceId,
      originKind: "official_collection",
      sourceFamily: seed.kind,
      sourceKindHint: seed.kind,
      tenantKey: seed.tenantKey,
      externalPostingId: job.identity.externalId ?? job.identity.stableKey,
      externalKey: `${seed.kind}:${seed.tenantKey}:${job.identity.stableKey}`,
      detailUrl: job.identity.canonicalUrl,
      officialUrl: job.identity.canonicalUrl,
      companyName,
      title,
      locationText,
      priority: corpusPriority(title, value),
      ...(published === undefined ? {} : { published, rawPublishedText: published.value }),
      observationKey: `${seed.kind}:${seed.tenantKey}:${job.identity.stableKey}:${observedAt.slice(0, 10)}`,
      payloadHash: createHash("sha256").update(job.raw).digest("hex"),
      observedAt,
      authoritative: true,
      responseMetadata: {
        requestedUrl: job.response.requestedUrl,
        status: job.response.status,
        officialReferrerUrl: seed.officialReferrerUrl ?? null,
      },
    });
  }
  return { snapshot, leads, excludedNonJapan, excludedUnknownLocation };
}

export function publicAtsBaseUrl(kind: PublicAtsTenantSeed["kind"], tenantKey: string): string {
  if (kind === "greenhouse") return `https://boards-api.greenhouse.io/v1/boards/${tenantKey}/jobs`;
  if (kind === "smartrecruiters") return `https://jobs.smartrecruiters.com/${tenantKey}`;
  if (kind === "lever") return `https://jobs.lever.co/${tenantKey}`;
  if (kind === "ashby") return `https://jobs.ashbyhq.com/${tenantKey}`;
  const [host, site] = tenantKey.split("/");
  if (host === undefined || site === undefined || !host.endsWith(".myworkdayjobs.com")) {
    throw new Error(`Invalid Workday tenant key ${tenantKey}`);
  }
  return `https://${host}/en-US/${site}`;
}

function publicAtsTitle(kind: PublicAtsTenantSeed["kind"], value: Record<string, unknown>): string | null {
  const workday = isRecord(value.jobPostingInfo) ? value.jobPostingInfo : {};
  const candidate = kind === "smartrecruiters" ? value.name : kind === "lever" ? value.text
    : kind === "workday" ? workday.title : value.title;
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate.trim() : null;
}

function publicAtsCompany(kind: PublicAtsTenantSeed["kind"], value: Record<string, unknown>): string | null {
  if (kind === "workday") {
    const organization = isRecord(value.hiringOrganization) ? value.hiringOrganization : {};
    return typeof organization.name === "string" && organization.name.trim() !== "" ? organization.name.trim() : null;
  }
  if (kind !== "smartrecruiters" || !isRecord(value.company)) return null;
  return typeof value.company.name === "string" ? value.company.name : null;
}

function publicAtsLocation(kind: PublicAtsTenantSeed["kind"], value: Record<string, unknown>): string {
  if (kind === "greenhouse") {
    const location = isRecord(value.location) ? value.location : {};
    return stringValues(location, ["name"]).join(", ");
  }
  if (kind === "smartrecruiters") {
    const location = isRecord(value.location) ? value.location : {};
    return stringValues(location, ["fullLocation", "city", "region", "country"]).join(", ");
  }
  if (kind === "lever") {
    const categories = isRecord(value.categories) ? value.categories : {};
    return [...stringValues(categories, ["location"]), ...stringArray(categories.allLocations)].join(", ");
  }
  if (kind === "workday") {
    const posting = isRecord(value.jobPostingInfo) ? value.jobPostingInfo : value;
    return [...stringValues(posting, ["location", "locations", "locationsText"]),
      ...stringArray(posting.additionalLocations)].join(", ");
  }
  const secondary = Array.isArray(value.secondaryLocations) ? value.secondaryLocations.flatMap((item) => {
    if (!isRecord(item)) return [];
    const address = isRecord(item.address) ? item.address : {};
    const postal = isRecord(address.postalAddress) ? address.postalAddress : address;
    return [...stringValues(item, ["location"]), ...stringValues(postal, ["addressLocality", "addressRegion", "addressCountry"])];
  }) : [];
  return [...stringValues(value, ["location"]), ...secondary].join(", ");
}

function publicAtsPublished(kind: PublicAtsTenantSeed["kind"], value: Record<string, unknown>): JobDiscoveryLead["published"] {
  const workday = isRecord(value.jobPostingInfo) ? value.jobPostingInfo : {};
  const raw = kind === "greenhouse" ? value.first_published : kind === "smartrecruiters" ? value.releasedDate : kind === "ashby" ? value.publishedAt
    : kind === "workday" ? workday.startDate : undefined;
  if (kind === "lever" && typeof value.createdAt === "number" && Number.isFinite(value.createdAt)) {
    return parsePublishedDateValue(new Date(value.createdAt).toISOString());
  }
  return typeof raw === "string" ? parsePublishedDateValue(raw) : undefined;
}

function corpusPriority(title: string, value: Record<string, unknown>): "p0" | "p1" | "p2" | "p3" {
  const text = `${title} ${JSON.stringify(value)}`;
  if (/software|engineer|developer|product|web|AI|machine learning|data|e.?commerce|IT|システム|エンジニア|開発|プロダクト/i.test(text)) return "p0";
  if (/consult|human resources|recruit|talent acquisition|people operations|人事|採用|コンサル/i.test(text)) return "p1";
  if (/介護|特定技能|specified skilled worker/i.test(text)) return "p3";
  return "p2";
}

function parseObject(raw: Uint8Array): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(raw));
  return isRecord(value) ? value : {};
}

function stringValues(value: Record<string, unknown>, keys: string[]): string[] {
  return keys.flatMap((key) => typeof value[key] === "string" && value[key] !== "" ? [value[key] as string] : []);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isPublicAtsKind(kind: SourceKind): kind is PublicAtsTenantSeed["kind"] {
  return kind === "greenhouse" || kind === "smartrecruiters" || kind === "lever" || kind === "ashby" || kind === "workday";
}
