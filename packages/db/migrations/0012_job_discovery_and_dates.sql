ALTER TYPE source_kind ADD VALUE IF NOT EXISTS 'smartrecruiters';
ALTER TYPE source_kind ADD VALUE IF NOT EXISTS 'lever';
ALTER TYPE source_kind ADD VALUE IF NOT EXISTS 'ashby';
ALTER TYPE source_kind ADD VALUE IF NOT EXISTS 'workday';

ALTER TYPE discovery_source_kind ADD VALUE IF NOT EXISTS 'public_ats';
ALTER TYPE discovery_source_kind ADD VALUE IF NOT EXISTS 'official_career_site';
ALTER TYPE discovery_source_kind ADD VALUE IF NOT EXISTS 'search_index';
ALTER TYPE discovery_source_kind ADD VALUE IF NOT EXISTS 'aggregator_lead';

BEGIN;

CREATE TYPE job_discovery_origin_kind AS ENUM (
  'official_collection',
  'official_single_record',
  'search_index',
  'aggregator_lead'
);

CREATE TYPE job_discovery_location_state AS ENUM ('japan', 'non_japan', 'unknown');
CREATE TYPE job_discovery_candidate_state AS ENUM (
  'discovered',
  'resolving',
  'resolved',
  'promoted',
  'rejected',
  'expired'
);
CREATE TYPE job_promotion_attempt_state AS ENUM (
  'pending',
  'leased',
  'retryable_failed',
  'succeeded',
  'terminal_failed'
);
CREATE TYPE job_date_kind AS ENUM ('published', 'source_updated', 'valid_through');
CREATE TYPE job_date_precision AS ENUM ('date', 'datetime');

CREATE TABLE job_discovery_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_source_id uuid NOT NULL REFERENCES discovery_sources(id) ON DELETE CASCADE,
  origin_kind job_discovery_origin_kind NOT NULL,
  source_family text NOT NULL,
  source_kind_hint source_kind,
  tenant_key text,
  external_posting_id text,
  external_key text NOT NULL,
  detail_url text NOT NULL,
  normalized_detail_url text NOT NULL,
  official_url text,
  normalized_official_url text,
  company_name text NOT NULL,
  normalized_company_name text NOT NULL,
  title text NOT NULL,
  location_text text NOT NULL,
  location_state job_discovery_location_state NOT NULL,
  priority corpus_priority NOT NULL DEFAULT 'p2',
  state job_discovery_candidate_state NOT NULL DEFAULT 'discovered',
  observation_count integer NOT NULL DEFAULT 0 CHECK (observation_count >= 0),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  last_authoritative_seen_at timestamptz,
  source_published_date date,
  source_published_at timestamptz,
  source_published_precision job_date_precision,
  resolved_source_instance_id uuid REFERENCES source_instances(id),
  promoted_source_job_record_id uuid REFERENCES source_job_records(id),
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (last_seen_at >= first_seen_at),
  CHECK (
    (source_published_precision IS NULL AND source_published_date IS NULL AND source_published_at IS NULL)
    OR (source_published_precision = 'date' AND source_published_date IS NOT NULL AND source_published_at IS NULL)
    OR (source_published_precision = 'datetime' AND source_published_date IS NULL AND source_published_at IS NOT NULL)
  ),
  CHECK (
    state NOT IN ('resolved', 'promoted')
    OR (official_url IS NOT NULL AND normalized_official_url IS NOT NULL AND resolved_source_instance_id IS NOT NULL)
  ),
  CHECK (state <> 'promoted' OR promoted_source_job_record_id IS NOT NULL),
  CHECK (state NOT IN ('rejected', 'expired') OR rejection_reason IS NOT NULL)
);

CREATE UNIQUE INDEX job_discovery_candidates_source_external_unique
  ON job_discovery_candidates (source_family, tenant_key, external_posting_id)
  WHERE tenant_key IS NOT NULL AND external_posting_id IS NOT NULL;
CREATE UNIQUE INDEX job_discovery_candidates_official_url_unique
  ON job_discovery_candidates (normalized_official_url)
  WHERE normalized_official_url IS NOT NULL;
CREATE UNIQUE INDEX job_discovery_candidates_detail_url_unique
  ON job_discovery_candidates (normalized_detail_url);
CREATE INDEX job_discovery_candidates_source_fk_idx
  ON job_discovery_candidates (discovery_source_id);
CREATE INDEX job_discovery_candidates_resolved_source_fk_idx
  ON job_discovery_candidates (resolved_source_instance_id)
  WHERE resolved_source_instance_id IS NOT NULL;
CREATE INDEX job_discovery_candidates_promoted_record_fk_idx
  ON job_discovery_candidates (promoted_source_job_record_id)
  WHERE promoted_source_job_record_id IS NOT NULL;
CREATE INDEX job_discovery_candidates_queue_idx
  ON job_discovery_candidates (state, priority, last_seen_at DESC, id)
  WHERE state IN ('discovered', 'resolving', 'resolved');
CREATE INDEX job_discovery_candidates_fresh_official_idx
  ON job_discovery_candidates (last_authoritative_seen_at DESC, id)
  WHERE origin_kind = 'official_collection' AND location_state = 'japan';
CREATE INDEX job_discovery_candidates_fresh_lead_idx
  ON job_discovery_candidates (last_seen_at DESC, id)
  WHERE origin_kind <> 'official_collection' AND location_state = 'japan' AND observation_count >= 2;
CREATE INDEX job_discovery_candidates_company_trgm_idx
  ON job_discovery_candidates USING gin (normalized_company_name gin_trgm_ops);
CREATE INDEX job_discovery_candidates_title_trgm_idx
  ON job_discovery_candidates USING gin (title gin_trgm_ops);

COMMENT ON TABLE job_discovery_candidates IS
  'Untrusted job-level leads. Rows cannot enter recommendations or lifecycle reconciliation until promoted through a verified source.';

CREATE TABLE job_discovery_resolution_evidence (
  candidate_id uuid NOT NULL REFERENCES job_discovery_candidates(id) ON DELETE CASCADE,
  evidence_id uuid NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  PRIMARY KEY (candidate_id, evidence_id)
);

CREATE INDEX job_discovery_resolution_evidence_evidence_fk_idx
  ON job_discovery_resolution_evidence (evidence_id);

CREATE TABLE job_discovery_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES job_discovery_candidates(id) ON DELETE CASCADE,
  discovery_import_run_id uuid REFERENCES discovery_import_runs(id) ON DELETE SET NULL,
  observation_key text NOT NULL,
  source_url text NOT NULL,
  outbound_url text,
  raw_company_name text NOT NULL,
  raw_title text NOT NULL,
  raw_location_text text NOT NULL,
  raw_published_text text,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  response_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, observation_key)
);

CREATE INDEX job_discovery_observations_candidate_fk_idx
  ON job_discovery_observations (candidate_id, observed_at DESC);
CREATE INDEX job_discovery_observations_import_run_fk_idx
  ON job_discovery_observations (discovery_import_run_id)
  WHERE discovery_import_run_id IS NOT NULL;

CREATE TABLE job_discovery_review_clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_key char(64) NOT NULL UNIQUE CHECK (cluster_key ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL,
  state review_task_state NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_discovery_review_cluster_members (
  cluster_id uuid NOT NULL REFERENCES job_discovery_review_clusters(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES job_discovery_candidates(id) ON DELETE CASCADE,
  similarity numeric(5,4) NOT NULL CHECK (similarity >= 0 AND similarity <= 1),
  PRIMARY KEY (cluster_id, candidate_id)
);

CREATE INDEX job_discovery_review_cluster_members_candidate_fk_idx
  ON job_discovery_review_cluster_members (candidate_id);

CREATE TABLE job_promotion_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES job_discovery_candidates(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  state job_promotion_attempt_state NOT NULL DEFAULT 'pending',
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  failure_stage text,
  last_error text,
  source_job_record_id uuid REFERENCES source_job_records(id),
  canonical_job_id uuid REFERENCES canonical_jobs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (candidate_id, idempotency_key),
  CHECK (
    (state = 'leased' AND lease_owner IS NOT NULL AND leased_at IS NOT NULL AND lease_expires_at > leased_at)
    OR (state <> 'leased' AND lease_owner IS NULL AND leased_at IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (state IN ('succeeded', 'terminal_failed') AND completed_at IS NOT NULL)
    OR (state NOT IN ('succeeded', 'terminal_failed') AND completed_at IS NULL)
  ),
  CHECK (state <> 'succeeded' OR (source_job_record_id IS NOT NULL AND canonical_job_id IS NOT NULL))
);

CREATE INDEX job_promotion_attempts_candidate_fk_idx
  ON job_promotion_attempts (candidate_id);
CREATE INDEX job_promotion_attempts_source_record_fk_idx
  ON job_promotion_attempts (source_job_record_id)
  WHERE source_job_record_id IS NOT NULL;
CREATE INDEX job_promotion_attempts_canonical_job_fk_idx
  ON job_promotion_attempts (canonical_job_id)
  WHERE canonical_job_id IS NOT NULL;
CREATE INDEX job_promotion_attempts_claim_idx
  ON job_promotion_attempts (available_at, created_at, id)
  WHERE state IN ('pending', 'retryable_failed', 'leased');

CREATE TABLE extraction_job_date_states (
  extraction_id uuid NOT NULL REFERENCES source_job_extractions(id) ON DELETE CASCADE,
  date_kind job_date_kind NOT NULL,
  value_state explicit_value_state NOT NULL,
  PRIMARY KEY (extraction_id, date_kind)
);

CREATE TABLE extraction_job_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id uuid NOT NULL REFERENCES source_job_extractions(id) ON DELETE CASCADE,
  date_kind job_date_kind NOT NULL,
  precision job_date_precision NOT NULL,
  date_value date,
  timestamp_value timestamptz,
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  CHECK (
    (precision = 'date' AND date_value IS NOT NULL AND timestamp_value IS NULL)
    OR (precision = 'datetime' AND date_value IS NULL AND timestamp_value IS NOT NULL)
  ),
  UNIQUE NULLS NOT DISTINCT (extraction_id, date_kind, precision, date_value, timestamp_value, evidence_id)
);

CREATE INDEX extraction_job_dates_extraction_fk_idx
  ON extraction_job_dates (extraction_id, date_kind);
CREATE INDEX extraction_job_dates_evidence_fk_idx
  ON extraction_job_dates (evidence_id);

CREATE TABLE canonical_job_date_states (
  canonical_job_version_id uuid NOT NULL REFERENCES canonical_job_versions(id) ON DELETE CASCADE,
  date_kind job_date_kind NOT NULL,
  value_state explicit_value_state NOT NULL,
  PRIMARY KEY (canonical_job_version_id, date_kind)
);

CREATE TABLE canonical_job_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_job_version_id uuid NOT NULL REFERENCES canonical_job_versions(id) ON DELETE CASCADE,
  date_kind job_date_kind NOT NULL,
  precision job_date_precision NOT NULL,
  date_value date,
  timestamp_value timestamptz,
  source_role text NOT NULL CHECK (source_role IN ('primary', 'supporting')),
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  CHECK (
    (precision = 'date' AND date_value IS NOT NULL AND timestamp_value IS NULL)
    OR (precision = 'datetime' AND date_value IS NULL AND timestamp_value IS NOT NULL)
  ),
  UNIQUE NULLS NOT DISTINCT (
    canonical_job_version_id,
    date_kind,
    precision,
    date_value,
    timestamp_value,
    source_role,
    evidence_id
  )
);

CREATE INDEX canonical_job_dates_version_fk_idx
  ON canonical_job_dates (canonical_job_version_id, date_kind);
CREATE INDEX canonical_job_dates_evidence_fk_idx
  ON canonical_job_dates (evidence_id);

CREATE OR REPLACE FUNCTION set_default_source_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO source_schedules(source_instance_id,interval_hours,stale_refresh_allowed)
  VALUES (NEW.id,CASE NEW.source_kind WHEN 'greenhouse' THEN 12 ELSE 24 END,
    NEW.source_kind IN (
      'greenhouse','schema_org','hrmos','herp','jobcan','airwork','engage','talentio',
      'smartrecruiters','lever','ashby','workday'
    ))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

COMMIT;
