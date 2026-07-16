import type {
  CollectionPage,
  CollectionPageRequest,
  DiscoveredJob,
  ResponseMetadata,
  SourceConnector,
  SourceJobIdentity,
  SourceKind,
} from "../../contracts/src/index.js";
import { ConnectorError } from "../../contracts/src/index.js";

interface JsonResponse {
  bytes: Uint8Array;
  value: unknown;
  metadata: ResponseMetadata;
}

interface SmartPosting {
  id?: string;
  name?: string;
  ref?: string;
  postingUrl?: string;
  company?: { name?: string };
  location?: { fullLocation?: string };
}

interface LeverPosting {
  id?: string;
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  categories?: { location?: string; allLocations?: string[] };
}

interface AshbyPosting {
  id?: string;
  title?: string;
  jobUrl?: string;
  applyUrl?: string;
  location?: string;
  isListed?: boolean;
}

abstract class JsonAtsConnector implements SourceConnector {
  abstract readonly kind: SourceKind;

  constructor(
    protected readonly fetchImplementation: typeof fetch = fetch,
    protected readonly maximumBytes = 5 * 1024 * 1024,
  ) {}

  abstract fetchCollectionPage(request: CollectionPageRequest): Promise<CollectionPage>;
  abstract fetchRecord(identity: SourceJobIdentity, signal: AbortSignal): Promise<DiscoveredJob>;

  protected async fetchJson(url: URL, signal: AbortSignal): Promise<JsonResponse> {
    assertPublicAtsHost(this.kind, url);
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        redirect: "error",
        signal,
        headers: { accept: "application/json", "user-agent": "JapanJobAgent/0.2 (+private personal use)" },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ConnectorError("timeout", `Timed out fetching ${url}`, true);
      }
      throw error;
    }
    if (!response.ok) throw responseError(this.kind, response.status, url);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > this.maximumBytes) throw new ConnectorError("schema_changed", `${this.kind} response exceeds byte limit`, false);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) throw new ConnectorError("unexpected_empty_response", `Empty response from ${url}`, true);
    if (bytes.byteLength > this.maximumBytes) throw new ConnectorError("schema_changed", `${this.kind} response exceeds byte limit`, false);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch {
      throw new ConnectorError("schema_changed", `${this.kind} returned invalid JSON`, false);
    }
    return {
      bytes,
      value,
      metadata: {
        requestedUrl: url.toString(), finalUrl: url.toString(), status: response.status,
        fetchedAt: new Date().toISOString(), contentType: response.headers.get("content-type"),
        etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified"),
        requestId: response.headers.get("x-request-id"),
      },
    };
  }
}

export class SmartRecruitersConnector extends JsonAtsConnector {
  readonly kind = "smartrecruiters" as const;

  async fetchCollectionPage(request: CollectionPageRequest): Promise<CollectionPage> {
    const offset = parseOffset(request.cursor);
    const url = new URL(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(request.source.tenantKey)}/postings`);
    url.searchParams.set("limit", "100");
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("destination", "PUBLIC");
    const response = await this.fetchJson(url, request.signal);
    const value = record(response.value);
    const content = Array.isArray(value.content) ? value.content.filter(isRecord) as SmartPosting[] : null;
    const total = typeof value.totalFound === "number" ? value.totalFound : null;
    if (content === null || total === null) throw new ConnectorError("schema_changed", "SmartRecruiters list shape changed", false);
    const jobs = content.map((posting) => smartJob(request.source.id, request.source.tenantKey, posting,
      stableBytes(posting), response.metadata));
    const nextOffset = offset + content.length;
    return {
      jobs,
      ...(nextOffset < total ? { nextCursor: String(nextOffset) } : {}),
      isLastPage: nextOffset >= total,
      providerTotal: total,
      response: response.metadata,
    };
  }

  async fetchRecord(identity: SourceJobIdentity, signal: AbortSignal): Promise<DiscoveredJob> {
    const externalId = identity.externalId ?? identity.stableKey;
    const tenant = smartTenantFromIdentity(identity);
    const url = new URL(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(tenant)}/postings/${encodeURIComponent(externalId)}`);
    const response = await this.fetchJson(url, signal);
    return smartJob(identity.sourceInstanceId, tenant, record(response.value) as SmartPosting, response.bytes, response.metadata);
  }
}

export class LeverConnector extends JsonAtsConnector {
  readonly kind = "lever" as const;
  private readonly tenantBySourceId = new Map<string, string>();

  async fetchCollectionPage(request: CollectionPageRequest): Promise<CollectionPage> {
    const offset = parseOffset(request.cursor);
    this.tenantBySourceId.set(request.source.id, request.source.tenantKey);
    const url = new URL(`https://api.lever.co/v0/postings/${encodeURIComponent(request.source.tenantKey)}`);
    url.searchParams.set("mode", "json");
    url.searchParams.set("skip", String(offset));
    url.searchParams.set("limit", "100");
    const response = await this.fetchJson(url, request.signal);
    if (!Array.isArray(response.value)) throw new ConnectorError("schema_changed", "Lever list shape changed", false);
    const postings = response.value.filter(isRecord) as LeverPosting[];
    const jobs = postings.map((posting) => leverJob(request.source.id, request.source.tenantKey, posting,
      stableBytes(posting), response.metadata));
    return {
      jobs,
      ...(postings.length === 100 ? { nextCursor: String(offset + postings.length) } : {}),
      isLastPage: postings.length < 100,
      response: response.metadata,
    };
  }

  async fetchRecord(identity: SourceJobIdentity, signal: AbortSignal): Promise<DiscoveredJob> {
    const tenant = this.tenantBySourceId.get(identity.sourceInstanceId) ?? leverTenantFromUrl(identity.canonicalUrl);
    const externalId = identity.externalId ?? identity.stableKey;
    const url = new URL(`https://api.lever.co/v0/postings/${encodeURIComponent(tenant)}/${encodeURIComponent(externalId)}`);
    url.searchParams.set("mode", "json");
    const response = await this.fetchJson(url, signal);
    return leverJob(identity.sourceInstanceId, tenant, record(response.value) as LeverPosting, response.bytes, response.metadata);
  }
}

export class AshbyConnector extends JsonAtsConnector {
  readonly kind = "ashby" as const;
  private readonly boards = new Map<string, { tenant: string; jobs: Map<string, AshbyPosting>; metadata: ResponseMetadata }>();

  async fetchCollectionPage(request: CollectionPageRequest): Promise<CollectionPage> {
    if (request.cursor !== undefined) throw new ConnectorError("pagination_interrupted", "Ashby public board is not paginated", false);
    const response = await this.fetchBoard(request.source.tenantKey, request.signal);
    const jobs = [...response.jobs.entries()].map(([id, posting]) => ashbyJob(request.source.id, id, posting,
      stableBytes(posting), response.metadata));
    this.boards.set(request.source.id, { tenant: request.source.tenantKey, jobs: response.jobs, metadata: response.metadata });
    return { jobs, isLastPage: true, providerTotal: jobs.length, response: response.metadata };
  }

  async fetchRecord(identity: SourceJobIdentity, signal: AbortSignal): Promise<DiscoveredJob> {
    let board = this.boards.get(identity.sourceInstanceId);
    if (board === undefined) {
      const tenant = ashbyTenantFromUrl(identity.canonicalUrl);
      const response = await this.fetchBoard(tenant, signal);
      board = { tenant, jobs: response.jobs, metadata: response.metadata };
      this.boards.set(identity.sourceInstanceId, board);
    }
    const posting = board.jobs.get(identity.externalId ?? identity.stableKey);
    if (posting === undefined) throw new ConnectorError("record_closed", `Ashby posting ${identity.stableKey} is no longer listed`, false);
    return ashbyJob(identity.sourceInstanceId, identity.externalId ?? identity.stableKey, posting,
      stableBytes(posting), board.metadata);
  }

  private async fetchBoard(tenant: string, signal: AbortSignal) {
    const url = new URL(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(tenant)}`);
    url.searchParams.set("includeCompensation", "true");
    const response = await this.fetchJson(url, signal);
    const value = record(response.value);
    if (!Array.isArray(value.jobs)) throw new ConnectorError("schema_changed", "Ashby board shape changed", false);
    const jobs = new Map<string, AshbyPosting>();
    for (const posting of value.jobs.filter(isRecord) as AshbyPosting[]) {
      if (posting.isListed === false) continue;
      const id = ashbyPostingId(posting);
      if (id !== null) jobs.set(id, posting);
    }
    return { jobs, metadata: response.metadata };
  }
}

function smartJob(sourceInstanceId: string, tenant: string, posting: SmartPosting, raw: Uint8Array,
  response: ResponseMetadata): DiscoveredJob {
  if (typeof posting.id !== "string" || typeof posting.name !== "string") {
    throw new ConnectorError("schema_changed", "SmartRecruiters posting identity is missing", false);
  }
  const canonicalUrl = typeof posting.postingUrl === "string" ? posting.postingUrl
    : `https://jobs.smartrecruiters.com/${tenant}/${posting.id}`;
  return discovered(sourceInstanceId, posting.id, canonicalUrl, raw, response);
}

function leverJob(sourceInstanceId: string, tenant: string, posting: LeverPosting, raw: Uint8Array,
  response: ResponseMetadata): DiscoveredJob {
  if (typeof posting.id !== "string" || typeof posting.text !== "string") {
    throw new ConnectorError("schema_changed", "Lever posting identity is missing", false);
  }
  const canonicalUrl = typeof posting.hostedUrl === "string" ? posting.hostedUrl
    : `https://jobs.lever.co/${tenant}/${posting.id}`;
  return discovered(sourceInstanceId, posting.id, canonicalUrl, raw, response);
}

function ashbyJob(sourceInstanceId: string, id: string, posting: AshbyPosting, raw: Uint8Array,
  response: ResponseMetadata): DiscoveredJob {
  if (typeof posting.title !== "string" || typeof posting.jobUrl !== "string") {
    throw new ConnectorError("schema_changed", "Ashby posting identity is missing", false);
  }
  return discovered(sourceInstanceId, id, posting.jobUrl, raw, response);
}

function discovered(sourceInstanceId: string, externalId: string, canonicalUrl: string, raw: Uint8Array,
  response: ResponseMetadata): DiscoveredJob {
  return {
    identity: { sourceInstanceId, stableKey: externalId, externalId, canonicalUrl },
    recordUrl: canonicalUrl,
    raw: Uint8Array.from(raw),
    response,
  };
}

function smartTenantFromIdentity(identity: SourceJobIdentity): string {
  const url = new URL(identity.canonicalUrl);
  const fromApi = url.pathname.match(/^\/v1\/companies\/([^/]+)\/postings/)?.[1];
  const fromJobs = url.hostname === "jobs.smartrecruiters.com" ? url.pathname.split("/").filter(Boolean)[0] : undefined;
  const tenant = fromApi ?? fromJobs;
  if (tenant === undefined) throw new ConnectorError("schema_changed", "SmartRecruiters tenant is missing", false);
  return tenant;
}

function leverTenantFromUrl(value: string): string {
  const tenant = new URL(value).pathname.split("/").filter(Boolean)[0];
  if (tenant === undefined) throw new ConnectorError("schema_changed", "Lever tenant is missing", false);
  return tenant;
}

function ashbyTenantFromUrl(value: string): string {
  const tenant = new URL(value).pathname.split("/").filter(Boolean)[0];
  if (tenant === undefined) throw new ConnectorError("schema_changed", "Ashby tenant is missing", false);
  return tenant;
}

function ashbyPostingId(posting: AshbyPosting): string | null {
  if (typeof posting.id === "string") return posting.id;
  if (typeof posting.jobUrl !== "string") return null;
  return new URL(posting.jobUrl).pathname.split("/").filter(Boolean)[1] ?? null;
}

function parseOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) throw new ConnectorError("pagination_interrupted", `Invalid offset ${cursor}`, false);
  return offset;
}

function assertPublicAtsHost(kind: SourceKind, url: URL): void {
  const expected: Partial<Record<SourceKind, string>> = {
    smartrecruiters: "api.smartrecruiters.com",
    lever: "api.lever.co",
    ashby: "api.ashbyhq.com",
  };
  if (url.protocol !== "https:" || url.hostname !== expected[kind] || url.username !== "" || url.password !== "") {
    throw new ConnectorError("ssrf_blocked", `${kind} connector rejected ${url.origin}`, false);
  }
}

function responseError(kind: SourceKind, status: number, url: URL): ConnectorError {
  if (status === 403) return new ConnectorError("forbidden", `${kind} denied ${url}`, false);
  if (status === 404 || status === 410) return new ConnectorError("record_closed", `${kind} posting is closed`, false);
  if (status === 429) return new ConnectorError("rate_limited", `${kind} rate limited ${url}`, true);
  if (status >= 500) return new ConnectorError("upstream_error", `${kind} returned ${status} for ${url}`, true);
  return new ConnectorError("schema_changed", `${kind} returned ${status} for ${url}`, false);
}

function stableBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ConnectorError("schema_changed", "Expected a JSON object", false);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
