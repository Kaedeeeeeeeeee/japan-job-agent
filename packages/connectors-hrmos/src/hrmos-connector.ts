import { load } from "cheerio";
import type {
  CollectionPage,
  CollectionPageRequest,
  DiscoveredJob,
  ResponseMetadata,
  SourceConnector,
  SourceJobIdentity,
} from "../../contracts/src/index.js";
import { ConnectorError } from "../../contracts/src/index.js";

interface HrmosCollectionIdentity {
  externalId: string;
  url: string;
}

interface HrmosCollectionIndex {
  identities: HrmosCollectionIdentity[];
  providerTotal: number;
  nextCursor?: string;
}

export class HrmosConnector implements SourceConnector {
  readonly kind = "hrmos" as const;

  constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  async fetchCollectionPage(request: CollectionPageRequest): Promise<CollectionPage> {
    const page = request.cursor === undefined ? 1 : parseCursor(request.cursor);
    const listUrl = new URL(`/pages/${encodeURIComponent(request.source.tenantKey)}/jobs`, request.source.baseUrl);
    assertHrmosUrl(listUrl);
    if (page > 1) listUrl.searchParams.set("page", String(page));
    const list = await this.fetchBytes(listUrl, request.signal);
    const index = parseHrmosCollection(list.bytes, request.source.tenantKey, page);
    const jobs: DiscoveredJob[] = [];
    for (const identity of index.identities) {
      const detail = await this.fetchBytes(new URL(identity.url), request.signal);
      jobs.push(toDiscoveredJob(request.source.id, identity, detail.bytes, detail.metadata));
    }
    const result: CollectionPage = {
      jobs,
      isLastPage: index.nextCursor === undefined,
      providerTotal: index.providerTotal,
      response: list.metadata,
    };
    if (index.nextCursor !== undefined) result.nextCursor = index.nextCursor;
    return result;
  }

  async fetchRecord(identity: SourceJobIdentity, signal: AbortSignal): Promise<DiscoveredJob> {
    const url = new URL(identity.canonicalUrl);
    if (url.protocol !== "https:" || url.hostname !== "hrmos.co" || !/^\/pages\/[^/]+\/jobs\/[^/]+$/.test(url.pathname)) {
      throw new ConnectorError("schema_changed", "Invalid HRMOS record URL", false);
    }
    const detail = await this.fetchBytes(url, signal);
    const externalId = identity.externalId ?? url.pathname.split("/").at(-1);
    if (externalId === undefined) throw new ConnectorError("schema_changed", "HRMOS job id is missing", false);
    return toDiscoveredJob(identity.sourceInstanceId, { externalId, url: url.toString() }, detail.bytes, detail.metadata);
  }

  private async fetchBytes(url: URL, signal: AbortSignal): Promise<{ bytes: Uint8Array; metadata: ResponseMetadata }> {
    const requestedUrl = new URL(url);
    let currentUrl = new URL(url);
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      assertHrmosUrl(currentUrl);
      let response: Response;
      try {
        response = await this.fetchImplementation(currentUrl, {
          signal,
          redirect: "manual",
          headers: {
            accept: "text/html,application/xhtml+xml",
            "user-agent": "JapanJobAgent/0.2 (+private personal use)",
          },
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new ConnectorError("timeout", `Timed out fetching ${currentUrl}`, true);
        }
        throw error;
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (location === null) throw new ConnectorError("schema_changed", "HRMOS redirect omitted Location", false);
        currentUrl = new URL(location, currentUrl);
        continue;
      }
      if (!response.ok) throw responseError(response.status, currentUrl);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) throw new ConnectorError("unexpected_empty_response", `Empty response from ${currentUrl}`, true);
      return {
        bytes,
        metadata: {
          requestedUrl: requestedUrl.toString(),
          finalUrl: currentUrl.toString(),
          status: response.status,
          fetchedAt: new Date().toISOString(),
          contentType: response.headers.get("content-type"),
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
          requestId: response.headers.get("x-request-id"),
        },
      };
    }
    throw new ConnectorError("schema_changed", "Too many HRMOS redirects", false);
  }
}

export function parseHrmosCollection(bytes: Uint8Array, tenantKey: string, currentPage: number): HrmosCollectionIndex {
  const $ = load(new TextDecoder().decode(bytes));
  const prefix = `/pages/${tenantKey}/jobs/`;
  const identities = new Map<string, HrmosCollectionIdentity>();
  $('a[href*="/jobs/"]').each((_index, element) => {
    const href = $(element).attr("href");
    if (href === undefined) return;
    const url = new URL(href, "https://hrmos.co");
    if (url.hostname !== "hrmos.co" || !url.pathname.startsWith(prefix)) return;
    const externalId = url.pathname.slice(prefix.length).split("/")[0];
    if (externalId === undefined || externalId === "") return;
    identities.set(externalId, { externalId, url: `https://hrmos.co${prefix}${encodeURIComponent(externalId)}` });
  });
  const totalText = $("#jsi-total-count").attr("value") ?? $(".pg-count").first().text();
  const totalMatch = totalText.match(/\d+/);
  if (totalMatch === null) throw new ConnectorError("schema_changed", "HRMOS collection total is missing", false);
  const providerTotal = Number(totalMatch[0]);
  const nextPage = $(".pg-pagenation a").toArray()
    .map((element) => Number(cleanText($(element).text())))
    .filter((value) => Number.isInteger(value) && value > currentPage)
    .sort((a, b) => a - b)[0];
  const result: HrmosCollectionIndex = { identities: [...identities.values()], providerTotal };
  if (nextPage !== undefined) result.nextCursor = String(nextPage);
  return result;
}

function toDiscoveredJob(
  sourceInstanceId: string,
  item: HrmosCollectionIdentity,
  raw: Uint8Array,
  response: ResponseMetadata,
): DiscoveredJob {
  return {
    identity: {
      sourceInstanceId,
      stableKey: item.externalId,
      externalId: item.externalId,
      canonicalUrl: item.url,
    },
    recordUrl: item.url,
    raw: Uint8Array.from(raw),
    response,
    exactRecordResponse: true,
  };
}

function parseCursor(cursor: string): number {
  const page = Number(cursor);
  if (!Number.isInteger(page) || page < 2) throw new ConnectorError("pagination_interrupted", "Invalid HRMOS page cursor", false);
  return page;
}

function responseError(status: number, url: URL): ConnectorError {
  if (status === 403) return new ConnectorError("forbidden", `HRMOS denied ${url}`, false);
  if (status === 410 || status === 404) return new ConnectorError("record_closed", `HRMOS record unavailable at ${url}`, false);
  if (status === 429) return new ConnectorError("rate_limited", `HRMOS rate limited ${url}`, true);
  if (status >= 500) return new ConnectorError("upstream_error", `HRMOS returned ${status} for ${url}`, true);
  return new ConnectorError("schema_changed", `HRMOS returned ${status} for ${url}`, false);
}

function assertHrmosUrl(url: URL): void {
  if (url.protocol !== "https:" || url.hostname !== "hrmos.co" || url.username !== "" || url.password !== "") {
    throw new ConnectorError("ssrf_blocked", "HRMOS connector only permits https://hrmos.co", false);
  }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
