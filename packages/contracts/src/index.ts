import { z } from "zod";

export const sourceKindSchema = z.enum(["greenhouse", "schema_org", "manual"]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const sourceInstanceRefSchema = z.object({
  id: z.string().uuid(),
  sourceKind: sourceKindSchema,
  tenantKey: z.string().min(1),
  baseUrl: z.url(),
});
export type SourceInstanceRef = z.infer<typeof sourceInstanceRefSchema>;

export const companyRelationshipRefSchema = z.object({
  relationshipId: z.string().uuid(),
  sourceInstanceId: z.string().uuid(),
  companyId: z.string().uuid(),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime().nullable(),
  evidenceIds: z.array(z.string().uuid()).min(1),
});
export type CompanyRelationshipRef = z.infer<typeof companyRelationshipRefSchema>;

export const sourceJobIdentitySchema = z.object({
  sourceInstanceId: z.string().uuid(),
  stableKey: z.string().min(1),
  externalId: z.string().min(1).optional(),
  canonicalUrl: z.url(),
});
export type SourceJobIdentity = z.infer<typeof sourceJobIdentitySchema>;

export const responseMetadataSchema = z.object({
  requestedUrl: z.url(),
  finalUrl: z.url(),
  status: z.number().int().min(100).max(599),
  fetchedAt: z.iso.datetime(),
  contentType: z.string().nullable(),
  etag: z.string().nullable(),
  lastModified: z.string().nullable(),
  requestId: z.string().nullable(),
});
export type ResponseMetadata = z.infer<typeof responseMetadataSchema>;

export const discoveredJobSchema = z.object({
  identity: sourceJobIdentitySchema,
  recordUrl: z.url(),
  raw: z.instanceof(Uint8Array),
  response: responseMetadataSchema,
});
export type DiscoveredJob = z.infer<typeof discoveredJobSchema>;

export interface CollectionPageRequest {
  source: SourceInstanceRef;
  cursor?: string;
  signal: AbortSignal;
}

export interface CollectionPage {
  jobs: readonly DiscoveredJob[];
  nextCursor?: string;
  isLastPage: boolean;
  providerTotal?: number;
  response: ResponseMetadata;
}

export interface SourceConnector {
  readonly kind: SourceKind;
  fetchCollectionPage(request: CollectionPageRequest): Promise<CollectionPage>;
  fetchRecord(identity: SourceJobIdentity, signal: AbortSignal): Promise<DiscoveredJob>;
}

export const snapshotKindSchema = z.enum(["authoritative", "partial", "single_record"]);
export type SnapshotKind = z.infer<typeof snapshotKindSchema>;

export interface SnapshotValidation {
  allPagesCompleted: boolean;
  parseErrors: readonly string[];
  tenantIdentityConsistent: boolean;
  providerTotalMatched: boolean;
  circuitBreakerReasons: readonly string[];
}

export interface FinalizedSnapshot {
  kind: SnapshotKind;
  source: SourceInstanceRef;
  jobs: readonly DiscoveredJob[];
  pageCount: number;
  providerTotal?: number;
  finalizedAt: string;
  validation: SnapshotValidation;
}

export const connectorErrorCodeSchema = z.enum([
  "forbidden",
  "rate_limited",
  "upstream_error",
  "timeout",
  "pagination_interrupted",
  "schema_changed",
  "unexpected_empty_response",
  "tenant_identity_mismatch",
  "total_mismatch",
  "ssrf_blocked",
  "record_closed",
]);
export type ConnectorErrorCode = z.infer<typeof connectorErrorCodeSchema>;

export class ConnectorError extends Error {
  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export const sourceHealthSchema = z.object({
  state: z.enum(["healthy", "degraded", "blocked"]),
  lastSuccessAt: z.iso.datetime().nullable(),
  lastFailureAt: z.iso.datetime().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  errorCode: connectorErrorCodeSchema.nullable(),
  detail: z.string().nullable(),
});
export type SourceHealth = z.infer<typeof sourceHealthSchema>;

export interface SourceJobVersion {
  id: string;
  sourceJobRecordId: string;
  rawHash: string;
  contentHash: string;
  canonicalizationVersion: string;
  raw: Uint8Array;
  sourceUrl: string;
  fetchedAt: string;
}

export interface ParserContext {
  source: SourceInstanceRef;
  localeHints: readonly string[];
}

export interface ExtractionCandidate {
  status: "succeeded" | "failed";
  structured: Readonly<Record<string, unknown>>;
  evidence: readonly EvidenceCandidate[];
  errors: readonly string[];
}

export interface EvidenceCandidate {
  fieldPath: string;
  quotedText: string;
  sourceUrl: string;
  locator: Readonly<Record<string, unknown>>;
}

export interface JobParser {
  readonly parserKey: string;
  readonly parserVersion: string;
  readonly schemaVersion: string;
  parse(version: SourceJobVersion, context: ParserContext): Promise<ExtractionCandidate>;
}

export type ExplicitState<T> =
  | { state: "known"; values: readonly T[]; evidenceIds: readonly string[] }
  | { state: "unknown"; values: readonly []; evidenceIds: readonly [] }
  | { state: "conflicting"; values: readonly T[]; evidenceIds: readonly string[] };
