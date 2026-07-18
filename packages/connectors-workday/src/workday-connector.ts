import type {
  CollectionPage,
  CollectionPageRequest,
  DiscoveredJob,
  ResponseMetadata,
  SourceConnector,
  SourceInstanceRef,
  SourceJobIdentity,
} from "../../contracts/src/index.js";
import { ConnectorError } from "../../contracts/src/index.js";

const PAGE_SIZE = 20;

interface WorkdayListPosting {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: unknown[];
}

interface WorkdayListResponse {
  total?: number;
  jobPostings?: unknown[];
}

interface WorkdayDetailResponse {
  jobPostingInfo?: {
    title?: string;
    jobReqId?: string;
    externalUrl?: string;
    startDate?: string;
  };
}

interface WorkdayBoardIdentity {
  host: string;
  tenant: string;
  site: string;
  publicBaseUrl: string;
}

interface JsonResponse {
  bytes: Uint8Array;
  value: unknown;
  metadata: ResponseMetadata;
}

export class WorkdayConnector implements SourceConnector {
  readonly kind = "workday" as const;

  constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly maximumBytes = 8 * 1024 * 1024,
    private readonly searchText = "",
  ) {}

  async fetchCollectionPage(request: CollectionPageRequest): Promise<CollectionPage> {
    const cursor = parseCursor(request.cursor);
    const offset = cursor.offset;
    const board = workdayBoardFromSource(request.source);
    const url = new URL(`/wday/cxs/${encodeURIComponent(board.tenant)}/${encodeURIComponent(board.site)}/jobs`,
      `https://${board.host}`);
    const fetched = await this.fetchJson(url, request.signal, {
      appliedFacets: {},
      limit: PAGE_SIZE,
      offset,
      searchText: this.searchText,
    });
    const value = asRecord(fetched.value) as WorkdayListResponse;
    if (!Number.isInteger(value.total) || !Array.isArray(value.jobPostings)) {
      throw new ConnectorError("schema_changed", "Workday list shape changed", false);
    }
    const postings = value.jobPostings.filter(isRecord) as WorkdayListPosting[];
    const jobs = postings.map((posting) => listJob(request.source.id, board, posting, fetched.metadata));
    const responseTotal = value.total!;
    const total = offset > 0 && responseTotal === 0 && cursor.providerTotal !== undefined
      ? cursor.providerTotal : responseTotal;
    const nextOffset = offset + postings.length;
    if (postings.length === 0 && nextOffset < total) {
      throw new ConnectorError("pagination_interrupted", `Workday returned an empty page before ${total} jobs`, true);
    }
    return {
      jobs,
      ...(nextOffset < total ? { nextCursor: `${nextOffset}:${total}` } : {}),
      isLastPage: nextOffset >= total,
      providerTotal: total,
      response: fetched.metadata,
    };
  }

  async fetchRecord(identity: SourceJobIdentity, signal: AbortSignal): Promise<DiscoveredJob> {
    const board = workdayBoardFromJobUrl(identity.canonicalUrl);
    const publicUrl = new URL(identity.canonicalUrl);
    const externalPath = externalPathFromJobUrl(publicUrl, board.site);
    const url = new URL(`/wday/cxs/${encodeURIComponent(board.tenant)}/${encodeURIComponent(board.site)}${externalPath}`,
      `https://${board.host}`);
    const fetched = await this.fetchJson(url, signal);
    const value = asRecord(fetched.value) as WorkdayDetailResponse;
    if (!isRecord(value.jobPostingInfo) || typeof value.jobPostingInfo.title !== "string") {
      throw new ConnectorError("schema_changed", "Workday detail shape changed", false);
    }
    const canonicalUrl = safeExternalUrl(value.jobPostingInfo.externalUrl, board.host) ?? identity.canonicalUrl;
    return {
      identity: {
        sourceInstanceId: identity.sourceInstanceId,
        stableKey: identity.stableKey,
        externalId: value.jobPostingInfo.jobReqId ?? identity.externalId ?? identity.stableKey,
        canonicalUrl,
      },
      recordUrl: canonicalUrl,
      raw: Uint8Array.from(fetched.bytes),
      response: fetched.metadata,
      exactRecordResponse: true,
    };
  }

  private async fetchJson(url: URL, signal: AbortSignal, body?: Record<string, unknown>): Promise<JsonResponse> {
    assertWorkdayHost(url);
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          "user-agent": "JapanJobAgent/0.2 (+private personal use)",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ConnectorError("timeout", `Timed out fetching ${url}`, true);
      }
      throw error;
    }
    if (!response.ok) throw responseError(response.status, url);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > this.maximumBytes) {
      throw new ConnectorError("schema_changed", "Workday response exceeds byte limit", false);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) throw new ConnectorError("unexpected_empty_response", `Empty response from ${url}`, true);
    if (bytes.byteLength > this.maximumBytes) {
      throw new ConnectorError("schema_changed", "Workday response exceeds byte limit", false);
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new ConnectorError("schema_changed", "Workday returned invalid JSON", false);
    }
    return {
      bytes,
      value,
      metadata: {
        requestedUrl: url.toString(),
        finalUrl: response.url || url.toString(),
        status: response.status,
        fetchedAt: new Date().toISOString(),
        contentType: response.headers.get("content-type"),
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        requestId: response.headers.get("x-wd-request-id") ?? response.headers.get("x-request-id"),
      },
    };
  }
}

export function workdayBoardFromSource(source: Pick<SourceInstanceRef, "baseUrl" | "tenantKey">): WorkdayBoardIdentity {
  const url = new URL(source.baseUrl);
  assertWorkdayHost(url);
  const tenant = url.hostname.split(".")[0];
  if (tenant === undefined || tenant === "") throw new ConnectorError("schema_changed", "Workday tenant is missing", false);
  const segments = url.pathname.split("/").filter(Boolean);
  const site = segments.find((segment) => !isLocaleSegment(segment))
    ?? source.tenantKey.split("/").filter(Boolean).at(-1);
  if (site === undefined || site === "") throw new ConnectorError("schema_changed", "Workday career site is missing", false);
  const locale = segments.find(isLocaleSegment);
  return {
    host: url.hostname,
    tenant,
    site,
    publicBaseUrl: `https://${url.hostname}/${locale === undefined ? "" : `${locale}/`}${site}`,
  };
}

export function workdayTenantKey(value: string): string {
  const url = new URL(value);
  const board = workdayBoardFromSource({ baseUrl: value, tenantKey: url.hostname });
  return `${board.host}/${board.site}`;
}

function workdayBoardFromJobUrl(value: string): WorkdayBoardIdentity {
  const url = new URL(value);
  assertWorkdayHost(url);
  const segments = url.pathname.split("/").filter(Boolean);
  const jobIndex = segments.indexOf("job");
  const site = jobIndex > 0 ? segments[jobIndex - 1] : undefined;
  const tenant = url.hostname.split(".")[0];
  if (tenant === undefined || tenant === "" || site === undefined || site === "") {
    throw new ConnectorError("schema_changed", "Cannot derive Workday tenant and career site", false);
  }
  const prefix = segments.slice(0, jobIndex - 1);
  return { host: url.hostname, tenant, site, publicBaseUrl: `https://${url.hostname}/${[...prefix, site].join("/")}` };
}

function externalPathFromJobUrl(url: URL, site: string): string {
  const segments = url.pathname.split("/").filter(Boolean);
  const jobIndex = segments.indexOf("job");
  if (jobIndex < 0 || segments[jobIndex - 1] !== site || segments.length <= jobIndex + 1) {
    throw new ConnectorError("schema_changed", "Workday job path is invalid", false);
  }
  return `/${segments.slice(jobIndex).map(encodeURIComponent).join("/")}`;
}

function listJob(sourceInstanceId: string, board: WorkdayBoardIdentity, posting: WorkdayListPosting,
  response: ResponseMetadata): DiscoveredJob {
  if (typeof posting.title !== "string" || typeof posting.externalPath !== "string"
    || !posting.externalPath.startsWith("/job/")) {
    throw new ConnectorError("schema_changed", "Workday posting identity is missing", false);
  }
  const requisition = posting.bulletFields?.find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim();
  const stableKey = requisition ?? stableKeyFromExternalPath(posting.externalPath);
  const canonicalUrl = `${board.publicBaseUrl}${posting.externalPath}`;
  return {
    identity: { sourceInstanceId, stableKey, externalId: stableKey, canonicalUrl },
    recordUrl: canonicalUrl,
    raw: new TextEncoder().encode(JSON.stringify(posting)),
    response,
  };
}

function stableKeyFromExternalPath(externalPath: string): string {
  const finalSegment = externalPath.split("/").filter(Boolean).at(-1);
  if (finalSegment === undefined || finalSegment === "") {
    throw new ConnectorError("schema_changed", "Workday posting path has no stable key", false);
  }
  return decodeURIComponent(finalSegment.split("_").at(-1) ?? finalSegment);
}

function safeExternalUrl(value: string | undefined, expectedHost: string): string | null {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    assertWorkdayHost(url);
    return url.hostname === expectedHost ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseCursor(cursor: string | undefined): { offset: number; providerTotal?: number } {
  if (cursor === undefined) return { offset: 0 };
  const [offsetText, totalText, ...extra] = cursor.split(":");
  const offset = Number(offsetText);
  const providerTotal = totalText === undefined ? undefined : Number(totalText);
  if (!Number.isInteger(offset) || offset < 0 || extra.length > 0
    || (providerTotal !== undefined && (!Number.isInteger(providerTotal) || providerTotal < offset))) {
    throw new ConnectorError("pagination_interrupted", `Invalid Workday offset ${cursor}`, false);
  }
  return { offset, ...(providerTotal === undefined ? {} : { providerTotal }) };
}

function isLocaleSegment(value: string): boolean {
  return /^[a-z]{2}(?:-[A-Z]{2})?$/.test(value);
}

function assertWorkdayHost(url: URL): void {
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== ""
    || !/^[a-z0-9-]+\.wd[0-9a-z-]*\.myworkdayjobs\.com$/i.test(url.hostname)) {
    throw new ConnectorError("forbidden", `Untrusted Workday host ${url.hostname}`, false);
  }
}

function responseError(status: number, url: URL): ConnectorError {
  if (status === 404 || status === 410) return new ConnectorError("record_closed", `Workday job is closed: ${url}`, false);
  if (status === 403) return new ConnectorError("forbidden", `Workday denied ${url}`, false);
  if (status === 429) return new ConnectorError("rate_limited", `Workday rate limited ${url}`, true);
  if (status >= 500) return new ConnectorError("upstream_error", `Workday returned ${status} for ${url}`, true);
  return new ConnectorError("schema_changed", `Workday returned ${status} for ${url}`, false);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ConnectorError("schema_changed", "Workday response is not an object", false);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
