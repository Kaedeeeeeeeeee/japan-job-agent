import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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

type Resolver = (hostname: string) => Promise<readonly string[]>;

export class SchemaOrgConnector implements SourceConnector {
  readonly kind = "schema_org" as const;

  constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly resolve: Resolver = resolvePublicAddresses,
    private readonly maximumBytes = 5 * 1024 * 1024,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fetchCollectionPage(_request: CollectionPageRequest): Promise<CollectionPage> {
    throw new ConnectorError("schema_changed", "schema.org is a single-record source", false);
  }

  async fetchRecord(identity: SourceJobIdentity, signal: AbortSignal): Promise<DiscoveredJob> {
    const fetched = await this.safeFetch(new URL(identity.canonicalUrl), signal);
    const posting = findJobPosting(fetched.bytes);
    const validThrough = stringValue(posting.validThrough);
    if (validThrough !== undefined) {
      const expiry = Date.parse(validThrough);
      if (!Number.isNaN(expiry) && expiry < this.now().getTime()) {
        throw new ConnectorError("record_closed", `JobPosting expired at ${validThrough}`, false);
      }
    }
    const postingUrl = stringValue(posting.url) ?? identity.canonicalUrl;
    const externalId = identifierValue(posting.identifier) ?? identity.externalId;
    return {
      identity: {
        sourceInstanceId: identity.sourceInstanceId,
        stableKey: externalId ?? createHash("sha256").update(postingUrl).digest("hex"),
        ...(externalId === undefined ? {} : { externalId }),
        canonicalUrl: postingUrl,
      },
      recordUrl: postingUrl,
      raw: Uint8Array.from(fetched.bytes),
      response: fetched.metadata,
    };
  }

  private async safeFetch(initialUrl: URL, signal: AbortSignal): Promise<{ bytes: Uint8Array; metadata: ResponseMetadata }> {
    let current = initialUrl;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      await assertPublicHttpsUrl(current, this.resolve);
      const response = await this.fetchImplementation(current, {
        signal,
        redirect: "manual",
        headers: { accept: "text/html,application/xhtml+xml", "user-agent": "JapanJobAgent/0.2 (+private personal use)" },
      });
      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        if (location === null) throw new ConnectorError("schema_changed", "Redirect omitted Location", false);
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        if (response.status === 410) throw new ConnectorError("record_closed", `${current} returned 410`, false);
        if (response.status === 403) throw new ConnectorError("forbidden", `${current} returned 403`, false);
        if (response.status === 429) throw new ConnectorError("rate_limited", `${current} returned 429`, true);
        if (response.status >= 500) throw new ConnectorError("upstream_error", `${current} returned ${response.status}`, true);
        throw new ConnectorError("schema_changed", `${current} returned ${response.status}`, false);
      }
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > this.maximumBytes) throw new ConnectorError("schema_changed", "Response exceeds size limit", false);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) throw new ConnectorError("unexpected_empty_response", `Empty response from ${current}`, true);
      if (bytes.byteLength > this.maximumBytes) throw new ConnectorError("schema_changed", "Response exceeds size limit", false);
      return {
        bytes,
        metadata: responseMetadata(initialUrl, current, response),
      };
    }
    throw new ConnectorError("schema_changed", "Too many redirects", false);
  }
}

export async function assertPublicHttpsUrl(url: URL, resolve: Resolver = resolvePublicAddresses): Promise<void> {
  if (url.protocol !== "https:") throw new ConnectorError("ssrf_blocked", "Only HTTPS sources are allowed", false);
  if (url.username !== "" || url.password !== "") throw new ConnectorError("ssrf_blocked", "URL credentials are forbidden", false);
  const addresses = isIP(url.hostname) === 0 ? await resolve(url.hostname) : [url.hostname];
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new ConnectorError("ssrf_blocked", `Host ${url.hostname} resolves to a non-public address`, false);
  }
}

export function findJobPosting(bytes: Uint8Array): Record<string, unknown> {
  const $ = load(new TextDecoder().decode(bytes));
  for (const element of $('script[type="application/ld+json"]').toArray()) {
    const raw = $(element).text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const candidate of flattenJsonLd(parsed)) {
      const types = Array.isArray(candidate["@type"]) ? candidate["@type"] : [candidate["@type"]];
      if (types.includes("JobPosting")) return candidate;
    }
  }
  throw new ConnectorError("schema_changed", "Page contains no valid schema.org JobPosting", false);
}

function flattenJsonLd(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (value === null || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const graph = object["@graph"];
  return [object, ...(Array.isArray(graph) ? graph.flatMap(flattenJsonLd) : [])];
}

async function resolvePublicAddresses(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : undefined);
  if (ipv4 === undefined) return false;
  const parts = ipv4.split(".").map(Number);
  const [a = 0, b = 0] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function responseMetadata(requested: URL, final: URL, response: Response): ResponseMetadata {
  return {
    requestedUrl: requested.toString(),
    finalUrl: final.toString(),
    status: response.status,
    fetchedAt: new Date().toISOString(),
    contentType: response.headers.get("content-type"),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
    requestId: response.headers.get("x-request-id"),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function identifierValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && "value" in value) return stringValue(value.value);
  return undefined;
}
