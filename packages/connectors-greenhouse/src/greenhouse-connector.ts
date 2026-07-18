import type {
  CollectionPage,
  CollectionPageRequest,
  DiscoveredJob,
  ResponseMetadata,
  SourceConnector,
  SourceJobIdentity,
} from "../../contracts/src/index.js";
import { ConnectorError } from "../../contracts/src/index.js";

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  location: { name: string };
  updated_at?: string;
  first_published?: string;
  application_deadline?: string | null;
  content?: string;
}

interface GreenhouseCollection {
  jobs: GreenhouseJob[];
  meta?: { total?: number };
}

export class GreenhouseConnector implements SourceConnector {
  readonly kind = "greenhouse" as const;

  constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  async fetchCollectionPage(request: CollectionPageRequest): Promise<CollectionPage> {
    if (request.cursor !== undefined) {
      throw new ConnectorError("pagination_interrupted", "Greenhouse collection is a single-page endpoint", false);
    }
    const url = new URL(`/v1/boards/${encodeURIComponent(request.source.tenantKey)}/jobs`, request.source.baseUrl);
    url.searchParams.set("content", "true");
    const fetched = await this.fetchBytes(url, request.signal);
    const parsed = parseCollection(fetched.bytes);
    const jobs = parsed.jobs.map((item) => discoveredJob(request.source.id, item, fetched.metadata));
    return {
      jobs,
      isLastPage: true,
      providerTotal: parsed.meta?.total ?? jobs.length,
      response: fetched.metadata,
    };
  }

  async fetchRecord(identity: SourceJobIdentity, signal: AbortSignal): Promise<DiscoveredJob> {
    const sourceUrl = new URL(identity.canonicalUrl);
    const segments = sourceUrl.pathname.split("/").filter(Boolean);
    const jobsIndex = segments.lastIndexOf("jobs");
    const tenantKey = jobsIndex > 0 ? segments[jobsIndex - 1] : undefined;
    const externalId = identity.externalId ?? segments.at(-1);
    if (tenantKey === undefined || externalId === undefined || !/^\d+$/.test(externalId)) {
      throw new ConnectorError("schema_changed", "Cannot derive Greenhouse tenant and job id", false);
    }
    const url = new URL(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(tenantKey)}/jobs/${externalId}`);
    const fetched = await this.fetchBytes(url, signal);
    const parsed = parseJob(fetched.bytes);
    return discoveredJob(identity.sourceInstanceId, parsed, fetched.metadata, fetched.bytes);
  }

  private async fetchBytes(url: URL, signal: AbortSignal): Promise<{ bytes: Uint8Array; metadata: ResponseMetadata }> {
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        signal,
        headers: { accept: "application/json", "user-agent": "JapanJobAgent/0.2 (+private personal use)" },
        redirect: "follow",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ConnectorError("timeout", `Timed out fetching ${url}`, true);
      }
      throw error;
    }
    if (!response.ok) throw responseError(response.status, url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) throw new ConnectorError("unexpected_empty_response", `Empty response from ${url}`, true);
    return {
      bytes,
      metadata: {
        requestedUrl: url.toString(),
        finalUrl: response.url || url.toString(),
        status: response.status,
        fetchedAt: new Date().toISOString(),
        contentType: response.headers.get("content-type"),
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        requestId: response.headers.get("x-request-id"),
      },
    };
  }
}

function discoveredJob(
  sourceInstanceId: string,
  job: GreenhouseJob,
  response: ResponseMetadata,
  exactRaw?: Uint8Array,
): DiscoveredJob {
  return {
    identity: {
      sourceInstanceId,
      stableKey: String(job.id),
      externalId: String(job.id),
      canonicalUrl: job.absolute_url,
    },
    recordUrl: job.absolute_url,
      raw: Uint8Array.from(exactRaw ?? new TextEncoder().encode(JSON.stringify(job))),
      response,
      ...(exactRaw === undefined ? {} : { exactRecordResponse: true }),
  };
}

function parseCollection(bytes: Uint8Array): GreenhouseCollection {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (value === null || typeof value !== "object" || !("jobs" in value) || !Array.isArray(value.jobs)) {
    throw new ConnectorError("schema_changed", "Greenhouse response has no jobs array", false);
  }
  return value as GreenhouseCollection;
}

function parseJob(bytes: Uint8Array): GreenhouseJob {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (value === null || typeof value !== "object" || !("id" in value) || !("absolute_url" in value)) {
    throw new ConnectorError("schema_changed", "Greenhouse job response is invalid", false);
  }
  return value as GreenhouseJob;
}

function responseError(status: number, url: URL): ConnectorError {
  if (status === 403) return new ConnectorError("forbidden", `Greenhouse denied ${url}`, false);
  if (status === 429) return new ConnectorError("rate_limited", `Greenhouse rate limited ${url}`, true);
  if (status >= 500) return new ConnectorError("upstream_error", `Greenhouse returned ${status} for ${url}`, true);
  return new ConnectorError("schema_changed", `Greenhouse returned ${status} for ${url}`, false);
}
