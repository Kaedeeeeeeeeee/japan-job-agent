import { z } from "zod";

export const sourceKindSchema = z.enum([
  "greenhouse", "schema_org", "manual", "hrmos", "herp", "jobcan", "airwork", "engage", "talentio",
  "smartrecruiters", "lever", "ashby", "workday",
]);
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
  exactRecordResponse: z.boolean().optional(),
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

export const corpusPrioritySchema = z.enum(["p0", "p1", "p2", "p3"]);
export type CorpusPriority = z.infer<typeof corpusPrioritySchema>;

export const discoveryCandidateSchema = z.object({
  externalKey: z.string().min(1),
  displayName: z.string().min(1),
  detailUrl: z.url(),
  prefecture: z.string().min(1).nullable(),
  industryLabels: z.array(z.string().min(1)),
  desiredRoleLabels: z.array(z.string().min(1)),
  priority: corpusPrioritySchema,
  hiringInterest: z.boolean(),
  internshipAvailable: z.boolean(),
  englishSupport: z.boolean(),
  evidenceQuote: z.string().min(1),
});
export type DiscoveryCandidate = z.infer<typeof discoveryCandidateSchema>;

export const discoveryPageSchema = z.object({
  candidates: z.array(discoveryCandidateSchema),
  page: z.number().int().positive(),
  nextPage: z.number().int().positive().nullable(),
  providerTotal: z.number().int().nonnegative().optional(),
  fetchedAt: z.iso.datetime(),
  sourceUrl: z.url(),
});
export type DiscoveryPage = z.infer<typeof discoveryPageSchema>;

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
  parseCanonical?(
    version: SourceJobVersion,
    context: ParserContext,
    document: CanonicalDocument,
  ): Promise<ExtractionCandidate>;
}

export const jobDateValueSchema = z.object({
  value: z.string().min(1),
  precision: z.enum(["date", "datetime"]),
});
export type JobDateValue = z.infer<typeof jobDateValueSchema>;

export const jobDateFactSchema = z.object({
  state: z.enum(["known", "unknown", "conflicting"]),
  values: z.array(jobDateValueSchema),
}).superRefine((fact, context) => {
  if (fact.state === "unknown" && fact.values.length !== 0) {
    context.addIssue({ code: "custom", message: "unknown date facts cannot contain values" });
  }
  if (fact.state !== "unknown" && fact.values.length === 0) {
    context.addIssue({ code: "custom", message: "known or conflicting date facts require a value" });
  }
});
export type JobDateFact = z.infer<typeof jobDateFactSchema>;

export const jobDiscoveryOriginKindSchema = z.enum([
  "official_collection", "official_single_record", "search_index", "aggregator_lead",
]);
export type JobDiscoveryOriginKind = z.infer<typeof jobDiscoveryOriginKindSchema>;

export const jobDiscoveryLocationStateSchema = z.enum(["japan", "non_japan", "unknown"]);
export type JobDiscoveryLocationState = z.infer<typeof jobDiscoveryLocationStateSchema>;

export const jobDiscoveryCandidateStateSchema = z.enum([
  "discovered", "resolving", "resolved", "promoted", "rejected", "expired",
]);
export type JobDiscoveryCandidateState = z.infer<typeof jobDiscoveryCandidateStateSchema>;

export const jobDiscoveryLeadSchema = z.object({
  discoverySourceId: z.string().uuid(),
  originKind: jobDiscoveryOriginKindSchema,
  sourceFamily: z.string().min(1),
  sourceKindHint: sourceKindSchema.optional(),
  tenantKey: z.string().min(1).optional(),
  externalPostingId: z.string().min(1).optional(),
  externalKey: z.string().min(1),
  detailUrl: z.url(),
  officialUrl: z.url().optional(),
  companyName: z.string().min(1),
  title: z.string().min(1),
  locationText: z.string(),
  priority: corpusPrioritySchema,
  published: jobDateValueSchema.optional(),
  rawPublishedText: z.string().min(1).optional(),
  discoveryImportRunId: z.string().uuid().optional(),
  observationKey: z.string().min(1),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  observedAt: z.iso.datetime(),
  authoritative: z.boolean(),
  responseMetadata: z.record(z.string(), z.unknown()).default({}),
});
export type JobDiscoveryLead = z.infer<typeof jobDiscoveryLeadSchema>;

export const jobDiscoveryCandidateSchema = jobDiscoveryLeadSchema.omit({
  published: true,
  rawPublishedText: true,
  observationKey: true,
  payloadHash: true,
  observedAt: true,
  authoritative: true,
  responseMetadata: true,
}).extend({
  id: z.string().uuid(),
  state: jobDiscoveryCandidateStateSchema,
  locationState: jobDiscoveryLocationStateSchema,
  observationCount: z.number().int().nonnegative(),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  lastAuthoritativeSeenAt: z.iso.datetime().nullable(),
  lastAuthoritativeImportRunId: z.string().uuid().nullable(),
  resolvedSourceInstanceId: z.string().uuid().nullable(),
  promotedSourceJobRecordId: z.string().uuid().nullable(),
});
export type JobDiscoveryCandidate = z.infer<typeof jobDiscoveryCandidateSchema>;

export const jobDiscoveryObservationSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  observationKey: z.string().min(1),
  sourceUrl: z.url(),
  outboundUrl: z.url().nullable(),
  rawCompanyName: z.string(),
  rawTitle: z.string(),
  rawLocationText: z.string(),
  rawPublishedText: z.string().nullable(),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  responseMetadata: z.record(z.string(), z.unknown()),
  observedAt: z.iso.datetime(),
});
export type JobDiscoveryObservation = z.infer<typeof jobDiscoveryObservationSchema>;

export const candidateResolutionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("resolved"),
    officialUrl: z.url(),
    sourceInstanceId: z.string().uuid(),
    evidenceIds: z.array(z.string().uuid()).min(1),
  }),
  z.object({ status: z.literal("retryable"), reason: z.string().min(1), retryAt: z.iso.datetime() }),
  z.object({ status: z.literal("rejected"), reason: z.string().min(1) }),
]);
export type CandidateResolution = z.infer<typeof candidateResolutionSchema>;

export const jobPromotionAttemptSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  idempotencyKey: z.string().min(1),
  state: z.enum(["pending", "leased", "retryable_failed", "succeeded", "terminal_failed"]),
  availableAt: z.iso.datetime(),
  leaseOwner: z.string().nullable(),
  leaseExpiresAt: z.iso.datetime().nullable(),
  attemptCount: z.number().int().nonnegative(),
  failureStage: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type JobPromotionAttempt = z.infer<typeof jobPromotionAttemptSchema>;

export interface JobDiscoveryCollectionRequest {
  cursor?: string;
  signal: AbortSignal;
}

export interface JobDiscoveryCollectionPage {
  leads: readonly JobDiscoveryLead[];
  nextCursor?: string;
  isLastPage: boolean;
  providerTotal?: number;
}

export interface JobDiscoveryCollector {
  readonly sourceFamily: string;
  collectPage(request: JobDiscoveryCollectionRequest): Promise<JobDiscoveryCollectionPage>;
}

export interface CandidateResolver {
  resolve(candidate: JobDiscoveryCandidate, signal: AbortSignal): Promise<CandidateResolution>;
}

export type ExplicitState<T> =
  | { state: "known"; values: readonly T[]; evidenceIds: readonly string[] }
  | { state: "unknown"; values: readonly []; evidenceIds: readonly []; unknownReason: FactUnknownReason }
  | { state: "conflicting"; values: readonly T[]; evidenceIds: readonly string[] };

export const factUnknownReasonSchema = z.enum([
  "not_mentioned",
  "not_parsed",
  "unsupported_format",
  "low_confidence",
  "provider_failed",
]);
export type FactUnknownReason = z.infer<typeof factUnknownReasonSchema>;

export const jobReadinessSchema = z.enum(["ready", "pending_enrichment", "needs_review"]);
export type JobReadiness = z.infer<typeof jobReadinessSchema>;

export const canonicalSectionKindSchema = z.enum([
  "title",
  "employment",
  "location",
  "compensation",
  "responsibilities",
  "required_requirements",
  "preferred_requirements",
  "skills",
  "languages",
  "experience",
  "dates",
  "other",
]);
export type CanonicalSectionKind = z.infer<typeof canonicalSectionKindSchema>;

export interface CanonicalDocumentSection {
  id?: string;
  kind: CanonicalSectionKind;
  heading: string | null;
  ordinal: number;
  text: string;
  locator: Readonly<Record<string, unknown>>;
  textHash: string;
}

export interface CanonicalDocument {
  id?: string;
  sourceJobVersionId: string;
  adapterKey: string;
  adapterVersion: string;
  title: string;
  fullText: string;
  contentHash: string;
  sections: readonly CanonicalDocumentSection[];
}

export type EnrichableJobField =
  | "employmentTypes"
  | "locations"
  | "compensation"
  | "skills"
  | "languages"
  | "experienceRequirements";

export interface AiFactCandidate {
  field: EnrichableJobField;
  quote: string;
  sectionId: string;
  rawValue: string;
  normalizedCandidate: unknown;
  requirementKind: "required" | "preferred" | "mentioned";
}
