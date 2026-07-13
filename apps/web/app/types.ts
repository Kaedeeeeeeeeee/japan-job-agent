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

export interface JobView {
  canonicalJobId: string;
  canonicalJobVersionId: string;
  title: string;
  companyName: string;
  applicationUrl: string;
  sourceKind: string;
  sourceKey: string;
  fetchedAt: string;
  sourceHealth: string;
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
  recommendationRunId?: string;
  generatedAt?: string;
  total?: number;
  visible?: number;
  jobs: JobView[];
}
