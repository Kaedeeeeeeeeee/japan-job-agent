BEGIN;

CREATE TABLE source_tenant_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind source_kind NOT NULL,
  tenant_key text NOT NULL,
  company_name text,
  source_url text NOT NULL,
  discovery_basis text NOT NULL,
  discovery_locator jsonb NOT NULL DEFAULT '{}'::jsonb,
  japan_signal boolean NOT NULL DEFAULT false,
  japan_recent_job_count integer NOT NULL DEFAULT 0 CHECK (japan_recent_job_count >= 0),
  latest_published_on date,
  official_referrer_url text,
  official_referrer_basis text CHECK (official_referrer_basis IS NULL OR official_referrer_basis IN (
    'jpx', 'jetro', 'ats_company_url', 'repository_cname', 'repository_homepage', 'operator_review'
  )),
  review_state text NOT NULL DEFAULT 'discovered' CHECK (review_state IN (
    'discovered', 'eligible', 'scanning', 'scanned', 'verification_pending', 'verified',
    'discovery_only', 'retryable_failure', 'rejected'
  )),
  scan_backfill_days integer CHECK (scan_backfill_days IS NULL OR scan_backfill_days BETWEEN 1 AND 183),
  last_snapshot_kind snapshot_kind,
  last_scan_completed boolean NOT NULL DEFAULT false,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  failure_reason text,
  next_scan_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  claimed_from_state text CHECK (claimed_from_state IS NULL OR claimed_from_state IN (
    'discovered', 'eligible', 'scanned', 'verification_pending', 'verified', 'retryable_failure'
  )),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_scanned_at timestamptz,
  verified_at timestamptz,
  linked_source_instance_id uuid REFERENCES source_instances(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, tenant_key),
  CHECK (last_seen_at >= first_seen_at),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((lease_owner IS NULL) = (claimed_from_state IS NULL)),
  CHECK ((review_state = 'verified' AND verified_at IS NOT NULL AND linked_source_instance_id IS NOT NULL)
    OR review_state <> 'verified')
);

CREATE INDEX source_tenant_candidates_claim_idx
  ON source_tenant_candidates (review_state, next_scan_at, japan_signal DESC,
    japan_recent_job_count DESC, latest_published_on DESC NULLS LAST, last_scanned_at NULLS FIRST, id)
  WHERE review_state IN ('discovered', 'eligible', 'scanned', 'verification_pending', 'retryable_failure');

CREATE UNIQUE INDEX source_tenant_candidates_identity_ci_unique
  ON source_tenant_candidates (source_kind, lower(tenant_key));

CREATE INDEX source_tenant_candidates_lease_idx
  ON source_tenant_candidates (lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;

INSERT INTO source_tenant_candidates(source_kind,tenant_key,company_name,source_url,discovery_basis,
    discovery_locator,japan_signal,japan_recent_job_count,official_referrer_url,official_referrer_basis,
    review_state,verified_at,linked_source_instance_id)
SELECT source.source_kind,source.tenant_key,company.display_name,source.base_url,'existing_verified_source',
  jsonb_build_object('relationshipId',relationship.id,'evidenceId',link_evidence.id),true,
  count(record.id) FILTER (WHERE record.lifecycle_state='active')::int,
  link_evidence.source_url,'operator_review','verified',now(),source.id
FROM source_instances source
JOIN company_source_relationships relationship ON relationship.source_instance_id=source.id
  AND relationship.verification_state='verified' AND relationship.valid_to IS NULL
JOIN companies company ON company.id=relationship.company_id AND company.verification_state='verified'
JOIN LATERAL (SELECT evidence.id,evidence.source_url FROM evidence
  WHERE evidence.company_source_relationship_id=relationship.id ORDER BY evidence.created_at DESC,evidence.id DESC LIMIT 1) link_evidence ON true
LEFT JOIN source_job_records record ON record.source_instance_id=source.id
WHERE source.verification_state='verified' AND source.source_kind IN
  ('greenhouse','workday','smartrecruiters','lever','ashby','hrmos','herp','talentio')
GROUP BY source.id,company.display_name,relationship.id,link_evidence.id,link_evidence.source_url
ON CONFLICT(source_kind,(lower(tenant_key))) DO NOTHING;

INSERT INTO source_tenant_candidates(source_kind,tenant_key,company_name,source_url,discovery_basis,
    discovery_locator,japan_signal,official_referrer_url,official_referrer_basis,review_state,
    verified_at,linked_source_instance_id)
SELECT candidate.source_kind,candidate.tenant_key,company.display_name,candidate.collection_url,'existing_company_discovery',
  jsonb_build_object('companyDiscoveryCandidateId',company.id,'sourceDiscoveryCandidateId',candidate.id),true,
  candidate.official_referrer_url,CASE WHEN source.source_key='jetro-ofp' THEN 'jetro' ELSE 'operator_review' END,
  CASE WHEN candidate.state='verified' THEN 'verified' ELSE 'discovered' END,
  candidate.verified_at,candidate.linked_source_instance_id
FROM source_discovery_candidates candidate
JOIN company_discovery_candidates company ON company.id=candidate.company_discovery_candidate_id
JOIN discovery_sources source ON source.id=company.discovery_source_id
WHERE candidate.source_kind IN ('greenhouse','workday','smartrecruiters','lever','ashby','hrmos','herp','talentio')
  AND candidate.state<>'rejected'
  AND (candidate.state<>'verified' OR (candidate.verified_at IS NOT NULL AND candidate.linked_source_instance_id IS NOT NULL))
ON CONFLICT(source_kind,(lower(tenant_key))) DO UPDATE SET
  company_name=COALESCE(source_tenant_candidates.company_name,excluded.company_name),
  official_referrer_url=COALESCE(source_tenant_candidates.official_referrer_url,excluded.official_referrer_url),
  official_referrer_basis=COALESCE(source_tenant_candidates.official_referrer_basis,excluded.official_referrer_basis),
  japan_signal=true,last_seen_at=now(),updated_at=now();

INSERT INTO source_tenant_candidates(source_kind,tenant_key,company_name,source_url,discovery_basis,
    discovery_locator,japan_signal,japan_recent_job_count,latest_published_on,official_referrer_url,
    official_referrer_basis,review_state)
SELECT candidate.source_kind_hint,candidate.tenant_key,max(candidate.company_name),min(candidate.detail_url),
  'existing_job_discovery',jsonb_build_object('candidateCount',count(*)),true,
  count(*) FILTER (WHERE candidate.location_state='japan' AND candidate.publication_freshness='recent')::int,
  max(COALESCE(candidate.source_published_date,(candidate.source_published_at AT TIME ZONE 'Asia/Tokyo')::date)),
  max(NULLIF(observation.response_metadata->>'officialReferrerUrl','')),
  CASE WHEN max(NULLIF(observation.response_metadata->>'officialReferrerUrl','')) IS NULL THEN NULL ELSE 'operator_review' END,
  'discovered'
FROM job_discovery_candidates candidate
LEFT JOIN job_discovery_observations observation ON observation.candidate_id=candidate.id
WHERE candidate.source_kind_hint IN ('greenhouse','workday','smartrecruiters','lever','ashby','hrmos','herp','talentio')
  AND candidate.tenant_key IS NOT NULL AND candidate.content_purged_at IS NULL
GROUP BY candidate.source_kind_hint,candidate.tenant_key
ON CONFLICT(source_kind,(lower(tenant_key))) DO UPDATE SET
  company_name=COALESCE(source_tenant_candidates.company_name,excluded.company_name),
  japan_signal=source_tenant_candidates.japan_signal OR excluded.japan_signal,
  japan_recent_job_count=GREATEST(source_tenant_candidates.japan_recent_job_count,excluded.japan_recent_job_count),
  latest_published_on=GREATEST(source_tenant_candidates.latest_published_on,excluded.latest_published_on),
  official_referrer_url=COALESCE(source_tenant_candidates.official_referrer_url,excluded.official_referrer_url),
  official_referrer_basis=COALESCE(source_tenant_candidates.official_referrer_basis,excluded.official_referrer_basis),
  last_seen_at=now(),updated_at=now();

CREATE TABLE source_expansion_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_kind text NOT NULL CHECK (run_kind IN ('import', 'scan', 'promote', 'quality_cleanup', 'acceptance')),
  status sync_status NOT NULL DEFAULT 'running',
  backfill_days integer CHECK (backfill_days IS NULL OR backfill_days BETWEEN 1 AND 183),
  requested_batch integer CHECK (requested_batch IS NULL OR requested_batch > 0),
  baseline_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  final_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_summary jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'running' AND finished_at IS NULL) OR (status <> 'running' AND finished_at IS NOT NULL))
);

CREATE INDEX source_expansion_runs_recent_idx
  ON source_expansion_runs (run_kind, started_at DESC, id);

CREATE TABLE source_quality_cleanup_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cleanup_kind text NOT NULL CHECK (cleanup_kind IN (
    'unverified_formal_hidden', 'parser_resync', 'parser_quarantined', 'canonical_shell_deleted'
  )),
  entity_kind text NOT NULL,
  entity_id uuid NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cleanup_kind, entity_kind, entity_id)
);

COMMENT ON TABLE source_tenant_candidates IS
  'Persistent, idempotent discovery queue. Rows remain outside recommendations until strict official backlink promotion succeeds.';
COMMENT ON TABLE source_expansion_runs IS
  'Auditable metrics and counters for each source-expansion import, scan, promotion, cleanup, and acceptance run.';

COMMIT;
