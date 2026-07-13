import { load } from "cheerio";
import type { CollectionPage, CollectionPageRequest, DiscoveredJob, ResponseMetadata, SourceConnector, SourceJobIdentity } from "../../contracts/src/index.js";
import { ConnectorError } from "../../contracts/src/index.js";

type PublicCareerKind = "herp" | "jobcan";
interface IndexedRecord { externalId: string; url: string }

export class PublicCareerConnector implements SourceConnector {
  constructor(readonly kind: PublicCareerKind, private readonly fetchImplementation: typeof fetch = fetch,
    private readonly maximumBytes = 5 * 1024 * 1024) {}

  async fetchCollectionPage(request: CollectionPageRequest): Promise<CollectionPage> {
    if (request.cursor !== undefined) throw new ConnectorError("pagination_interrupted", `${this.kind} connector is internally paginated`, false);
    const collectionUrl = new URL(request.source.baseUrl);
    assertAllowedHost(this.kind, collectionUrl);
    const indexPages = [await this.fetchBytes(collectionUrl, request.signal)];
    if (this.kind === "jobcan") {
      for (const categoryUrl of parseJobcanCategoryUrls(indexPages[0]?.bytes ?? new Uint8Array(), request.source.tenantKey)) {
        indexPages.push(await this.fetchBytes(new URL(categoryUrl), request.signal));
      }
    }
    const records = new Map<string, IndexedRecord>();
    for (const page of indexPages) {
      for (const record of parseRecords(this.kind, page.bytes, request.source.tenantKey)) records.set(record.externalId, record);
    }
    const jobs: DiscoveredJob[] = [];
    for (const record of records.values()) {
      const detail = await this.fetchBytes(new URL(record.url), request.signal);
      jobs.push(toDiscoveredJob(request.source.id, record, detail.bytes, detail.metadata));
    }
    return { jobs, isLastPage: true, providerTotal: jobs.length, response: indexPages[0]?.metadata ?? emptyMetadata(collectionUrl) };
  }

  async fetchRecord(identity: SourceJobIdentity, signal: AbortSignal): Promise<DiscoveredJob> {
    const url = new URL(identity.canonicalUrl);
    assertAllowedHost(this.kind, url);
    const detail = await this.fetchBytes(url, signal);
    const externalId = identity.externalId ?? url.pathname.split("/").filter(Boolean).at(-1);
    if (externalId === undefined) throw new ConnectorError("schema_changed", `${this.kind} record id is missing`, false);
    return toDiscoveredJob(identity.sourceInstanceId, { externalId, url: url.toString() }, detail.bytes, detail.metadata);
  }

  private async fetchBytes(initialUrl: URL, signal: AbortSignal): Promise<{ bytes: Uint8Array; metadata: ResponseMetadata }> {
    let current = new URL(initialUrl);
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      assertAllowedHost(this.kind, current);
      let response: Response;
      try {
        response = await this.fetchImplementation(current, { redirect: "manual", signal, headers: {
          accept: "text/html,application/xhtml+xml", "user-agent": "JapanJobAgent/0.2 (+private personal use)",
        } });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw new ConnectorError("timeout", `Timed out fetching ${current}`, true);
        throw error;
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (location === null) throw new ConnectorError("schema_changed", "Redirect omitted Location", false);
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) throw responseError(this.kind, response.status, current);
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > this.maximumBytes) {
        throw new ConnectorError("schema_changed", `${this.kind} response exceeds the configured byte limit`, false);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) throw new ConnectorError("unexpected_empty_response", `Empty response from ${current}`, true);
      if (bytes.byteLength > this.maximumBytes) {
        throw new ConnectorError("schema_changed", `${this.kind} response exceeds the configured byte limit`, false);
      }
      return { bytes, metadata: { requestedUrl: initialUrl.toString(), finalUrl: current.toString(), status: response.status,
        fetchedAt: new Date().toISOString(), contentType: response.headers.get("content-type"), etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"), requestId: response.headers.get("x-request-id") } };
    }
    throw new ConnectorError("schema_changed", "Too many redirects", false);
  }
}

export function parseRecords(kind: PublicCareerKind, bytes: Uint8Array, tenantKey: string): IndexedRecord[] {
  const $ = load(new TextDecoder().decode(bytes));
  const records = new Map<string, IndexedRecord>();
  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    if (href === undefined) return;
    const base = kind === "herp" ? "https://herp.careers" : "https://recruit.jobcan.jp";
    const url = new URL(href, base);
    const pattern = kind === "herp"
      ? new RegExp(`^/v1/${escapeRegExp(tenantKey)}/([^/]+)$`)
      : new RegExp(`^/${escapeRegExp(tenantKey)}/job_offers/(\\d+)`);
    const externalId = url.pathname.match(pattern)?.[1];
    if (externalId !== undefined) records.set(externalId, { externalId, url: `${url.origin}${url.pathname}` });
  });
  return [...records.values()];
}

function parseJobcanCategoryUrls(bytes: Uint8Array, tenantKey: string): string[] {
  const $ = load(new TextDecoder().decode(bytes));
  const urls = new Set<string>();
  $(`a[href^="/${tenantKey}/list?"]`).each((_index, element) => {
    const href = $(element).attr("href");
    if (href !== undefined) urls.add(new URL(href, "https://recruit.jobcan.jp").toString());
  });
  return [...urls];
}

function toDiscoveredJob(sourceInstanceId: string, record: IndexedRecord, raw: Uint8Array, response: ResponseMetadata): DiscoveredJob {
  return { identity: { sourceInstanceId, stableKey: record.externalId, externalId: record.externalId, canonicalUrl: record.url },
    recordUrl: record.url, raw: Uint8Array.from(raw), response };
}

function assertAllowedHost(kind: PublicCareerKind, url: URL): void {
  const expected = kind === "herp" ? "herp.careers" : "recruit.jobcan.jp";
  if (url.protocol !== "https:" || url.hostname !== expected || url.username !== "" || url.password !== "") {
    throw new ConnectorError("ssrf_blocked", `${kind} connector only permits https://${expected}`, false);
  }
}

function responseError(kind: PublicCareerKind, status: number, url: URL): ConnectorError {
  if (status === 403) return new ConnectorError("forbidden", `${kind} denied ${url}`, false);
  if (status === 429) return new ConnectorError("rate_limited", `${kind} rate limited ${url}`, true);
  if (status >= 500) return new ConnectorError("upstream_error", `${kind} returned ${status} for ${url}`, true);
  return new ConnectorError("schema_changed", `${kind} returned ${status} for ${url}`, false);
}

function emptyMetadata(url: URL): ResponseMetadata {
  return { requestedUrl: url.toString(), finalUrl: url.toString(), status: 200, fetchedAt: new Date().toISOString(),
    contentType: null, etag: null, lastModified: null, requestId: null };
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
