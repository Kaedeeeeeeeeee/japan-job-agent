/**
 * Japan Job Data & Recommendation Agent
 * Core domain and connector contracts v0.1
 * Generated: 2026-07-12
 */

export type ISODateTime = string;
export type UUID = string;

export type SourceAccessMode =
  | "public_api"
  | "public_html"
  | "partner_feed"
  | "authenticated_api"
  | "manual";

export type SourceLifecycleStatus =
  | "active"
  | "degraded"
  | "blocked"
  | "disabled"
  | "retired";

export type SnapshotScope =
  | "authoritative"
  | "partial"
  | "delta"
  | "single_record";

export type SourceJobStatus =
  | "active"
  | "suspect"
  | "closed"
  | "archived"
  | "unknown";

export type CanonicalJobStatus = "active" | "suspect" | "closed" | "archived";

export type TriStateWithConflict =
  | "yes"
  | "no"
  | "case_by_case"
  | "unknown"
  | "conflicting";

export interface TenantRef {
  sourceInstanceId: UUID;
  companyId: UUID;
  providerCode: string;
  instanceKey: string;
  baseUrl: string;
  verifiedFromUrl: string;
  verifiedAt: ISODateTime;
  metadata?: Record<string, unknown>;
}

export interface RawJob {
  externalId: string | null;
  sourceIdentityKey: string;
  sourceUrl: string;
  canonicalSourceUrl?: string;
  applyUrl?: string;
  publishedAt?: ISODateTime;
  updatedAt?: ISODateTime;
  rawFormat: "json" | "html" | "xml" | "text" | "manual";
  rawPayload?: unknown;
  rawText?: string;
  contentHash: string;
}

export interface JobListResult {
  jobs: RawJob[];
  nextCursor?: string;
  fetchedAt: ISODateTime;
  snapshotScope: SnapshotScope;
  sourceRequestId?: string;
}

export interface SourceHealth {
  status: "healthy" | "degraded" | "blocked" | "failed";
  httpStatus?: number;
  retryAfterSeconds?: number;
  message?: string;
}

export interface EvidenceCandidate {
  fieldPath: string;
  evidenceText: string;
  evidenceUrl?: string;
  startOffset?: number;
  endOffset?: number;
  extractionMethod:
    | "structured_api"
    | "json_ld"
    | "deterministic_parser"
    | "rule_based"
    | "llm"
    | "manual";
  confidence: number;
}

export interface NormalizedJobCandidate {
  title: string;
  normalizedTitle: string;
  department?: string;
  jobFamilyCode?: string;
  seniorityLevel?: string;
  employmentType:
    | "permanent"
    | "fixed_term"
    | "contractor"
    | "temporary"
    | "part_time"
    | "internship"
    | "new_graduate"
    | "unknown";
  workArrangement: "onsite" | "hybrid" | "remote" | "unknown";
  descriptionText?: string;
  responsibilitiesText?: string;
  requirementsText?: string;
  minExperienceMonths?: number;
  maxExperienceMonths?: number;
  visaSupport: TriStateWithConflict;
  overseasApplication: TriStateWithConflict;
  residenceInJapanRequired: "yes" | "no" | "unknown" | "conflicting";
  applicationDeadline?: ISODateTime;
  locations: NormalizedLocation[];
  languageRequirements: NormalizedLanguageRequirement[];
  skills: NormalizedSkillRequirement[];
  compensation: NormalizedCompensation[];
  evidence: EvidenceCandidate[];
  structuredPayload: Record<string, unknown>;
}

export interface NormalizedLocation {
  countryCode?: string;
  region?: string;
  city?: string;
  addressText?: string;
  locationRole: "primary" | "alternate";
  workMode: "onsite" | "hybrid" | "remote" | "unknown";
  remoteScope: "japan_only" | "specific_regions" | "worldwide" | "unknown";
  onsiteDaysMin?: number;
  onsiteDaysMax?: number;
}

export interface NormalizedLanguageRequirement {
  languageCode: string;
  requirementType: "required" | "preferred" | "working_language";
  levelSystem: "jlpt" | "cefr" | "native" | "business" | "free_text" | "unknown";
  levelCode?: string;
  rawRequirement: string;
  confidence: number;
}

export interface NormalizedSkillRequirement {
  canonicalSkillKey?: string;
  rawSkillName: string;
  requirementType: "required" | "preferred" | "mentioned";
  minExperienceMonths?: number;
  confidence: number;
}

export interface NormalizedCompensation {
  componentType: "total" | "base" | "bonus" | "allowance" | "equity" | "other";
  currency: string;
  payPeriod: "hour" | "day" | "month" | "year";
  amountMin?: number;
  amountMax?: number;
  fixedOvertimeIncluded?: boolean;
  fixedOvertimeHoursMin?: number;
  fixedOvertimeHoursMax?: number;
  fixedOvertimeAmount?: number;
  rawText: string;
}

export interface NormalizeContext {
  tenant: TenantRef;
  sourceTrustScore: number;
  observedAt: ISODateTime;
  parserVersion: string;
}

export interface AtsConnector {
  readonly providerCode: string;
  readonly connectorVersion: string;

  discoverTenant(careerUrl: URL): Promise<TenantRef | null>;

  listJobs(tenant: TenantRef, cursor?: string): Promise<JobListResult>;

  getJob(tenant: TenantRef, externalJobId: string): Promise<RawJob | null>;

  normalize(rawJob: RawJob, context: NormalizeContext): Promise<NormalizedJobCandidate>;

  checkSourceHealth(tenant: TenantRef): Promise<SourceHealth>;
}

export interface RecommendationRequest {
  candidateProfileVersionId: UUID;
  queryText?: string;
  limit: number;
  forceRefreshStaleJobs?: boolean;
}

export interface FeatureScoreBreakdown {
  role: number;
  skill: number;
  language: number;
  visaAndEligibility: number;
  locationAndRemote: number;
  compensation: number;
  freshnessAndTrust: number;
  total: number;
}

export interface RecommendationExplanation {
  recommendation: "recommended" | "verify_first" | "not_recommended";
  summary: string;
  matched: ExplanationPoint[];
  gaps: ExplanationPoint[];
  unknowns: ExplanationPoint[];
  nextChecks: string[];
}

export interface ExplanationPoint {
  field: string;
  message: string;
  evidenceIds: UUID[];
}

export interface RecommendationResultItem {
  canonicalJobId: UUID;
  canonicalJobVersionId: UUID;
  rank: number;
  score: FeatureScoreBreakdown;
  explanation?: RecommendationExplanation;
}

export interface AgentToolContext {
  candidateProfileVersionId: UUID;
  recommendationRunId?: UUID;
  requestId: string;
}

export interface JobSearchToolInput {
  query?: string;
  hardFilters: Record<string, unknown>;
  limit: number;
  cursor?: string;
}

export interface JobEvidenceToolInput {
  canonicalJobVersionId: UUID;
  fieldPaths: string[];
}

export const DEFAULT_RANKING_WEIGHTS = {
  role: 25,
  skill: 25,
  language: 15,
  visaAndEligibility: 15,
  locationAndRemote: 10,
  compensation: 5,
  freshnessAndTrust: 5,
} as const;
