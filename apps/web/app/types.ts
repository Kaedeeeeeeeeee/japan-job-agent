export interface EvidenceView {
  id: string;
  field: string;
  quote: string;
  sourceUrl: string;
  locator: Record<string, unknown>;
}

export interface ExplanationItem {
  field: string;
  message: string;
  evidenceIds: string[];
}

export interface ScoreDimension {
  key: string;
  label: string;
  score: number;
  maximum: number;
  evidenceIds: string[];
  rationale: string;
}

export interface OccupationSelectionView {
  family: string;
  familyLabel: string;
  role: string;
  roleLabel: string;
}

export interface OccupationClassificationView {
  taxonomyVersion: string;
  primary: OccupationSelectionView;
  secondary: OccupationSelectionView[];
  specialtyTags: string[];
  confidence: "high" | "medium" | "low";
}

export interface OccupationFacetView {
  id: string;
  label: string;
  count: number;
}

export interface JobDateFactView {
  state: "known" | "unknown" | "conflicting";
  value: string | null;
  precision: "date" | "datetime" | null;
  evidenceIds: string[];
}

export interface JobView {
  canonicalJobId: string;
  canonicalJobVersionId: string;
  title: string;
  companyName: string;
  applicationUrl: string;
  sourceKind: string;
  sourceKey: string;
  fetchedAt: string;
  occupation: OccupationClassificationView;
  dates: {
    published: JobDateFactView;
    sourceUpdated: JobDateFactView;
    validThrough: JobDateFactView;
    firstSeenAt: string;
    lastSeenAt: string;
    fetchedAt: string;
    display: { kind: "published" | "first_seen"; value: string };
  };
  sourceHealth: string;
  readiness: "ready" | "pending_enrichment" | "needs_review";
  readinessReasons: string[];
  fieldStates: Record<string, {
    state: "known" | "unknown" | "conflicting";
    unknownReason: string | null;
    processing: boolean;
  }>;
  explanation: {
    status: "deterministic" | "pending" | "succeeded" | "failed";
    source: "deterministic" | "ai";
    summary: string | null;
    matched: ExplanationItem[] | null;
    gaps: ExplanationItem[] | null;
    error: string | null;
  };
  eligible: boolean;
  score: number;
  scoreBreakdown: ScoreDimension[];
  matched: ExplanationItem[];
  gaps: ExplanationItem[];
  unknowns: ExplanationItem[];
  hardRejectReasons: string[];
  evidence: EvidenceView[];
  state: { saved: boolean; hidden: boolean; appliedAt: string | null };
  refresh: {
    eligible: boolean;
    stale: boolean;
    reason: string | null;
    staleAt: string;
  };
}

export interface JobsResponse {
  profileConfigured: boolean;
  rankingVersion?: string;
  retrievalVersion?: string;
  embeddingModelKey?: string | null;
  occupationTaxonomyVersion?: string;
  facets?: { occupations: OccupationFacetView[] };
  recommendationRunId?: string;
  generatedAt?: string;
  total?: number;
  visible?: number;
  jobs: JobView[];
}
