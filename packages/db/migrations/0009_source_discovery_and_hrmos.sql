ALTER TYPE source_kind ADD VALUE IF NOT EXISTS 'hrmos';

BEGIN;

CREATE TYPE discovery_source_kind AS ENUM ('government_directory', 'government_job_list', 'event_list', 'manual_research');
CREATE TYPE discovery_candidate_state AS ENUM ('discovered', 'auditing', 'verified', 'rejected');
CREATE TYPE foreign_hiring_signal_kind AS ENUM (
  'foreign_talent_interest',
  'foreign_employee_track_record',
  'overseas_application',
  'visa_support',
  'english_support',
  'specified_skilled_worker_route'
);
CREATE TYPE corpus_priority AS ENUM ('p0', 'p1', 'p2', 'p3');

CREATE TABLE discovery_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL UNIQUE,
  name text NOT NULL,
  source_kind discovery_source_kind NOT NULL,
  base_url text NOT NULL,
  terms_url text,
  policy_notes text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE discovery_import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_source_id uuid NOT NULL REFERENCES discovery_sources(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  status sync_status NOT NULL DEFAULT 'running',
  page_count integer NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  provider_total integer CHECK (provider_total IS NULL OR provider_total >= 0),
  discovered_count integer NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  raw_hash text,
  validation_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error_detail text,
  UNIQUE (discovery_source_id, idempotency_key),
  CHECK ((status = 'running' AND finished_at IS NULL) OR (status <> 'running' AND finished_at IS NOT NULL))
);

CREATE TABLE discovery_import_pages (
  discovery_import_run_id uuid NOT NULL REFERENCES discovery_import_runs(id) ON DELETE CASCADE,
  page_number integer NOT NULL CHECK (page_number >= 1),
  source_url text NOT NULL,
  payload_hash text NOT NULL,
  raw_payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (discovery_import_run_id, page_number)
);

CREATE TABLE company_discovery_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_source_id uuid NOT NULL REFERENCES discovery_sources(id) ON DELETE CASCADE,
  external_key text NOT NULL,
  display_name text NOT NULL,
  normalized_name text NOT NULL,
  detail_url text NOT NULL,
  prefecture text,
  industry_labels text[] NOT NULL DEFAULT '{}',
  desired_role_labels text[] NOT NULL DEFAULT '{}',
  priority corpus_priority NOT NULL DEFAULT 'p2',
  state discovery_candidate_state NOT NULL DEFAULT 'discovered',
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  last_import_run_id uuid NOT NULL REFERENCES discovery_import_runs(id),
  linked_company_id uuid REFERENCES companies(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (discovery_source_id, external_key),
  CHECK (last_seen_at >= first_seen_at),
  CHECK ((state = 'verified' AND linked_company_id IS NOT NULL) OR state <> 'verified')
);

CREATE INDEX company_discovery_candidates_queue_idx
  ON company_discovery_candidates (state, priority, last_seen_at DESC);
CREATE INDEX company_discovery_candidates_name_trgm_idx
  ON company_discovery_candidates USING gin (normalized_name gin_trgm_ops);

CREATE TABLE company_foreign_hiring_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  discovery_candidate_id uuid REFERENCES company_discovery_candidates(id) ON DELETE CASCADE,
  signal_kind foreign_hiring_signal_kind NOT NULL,
  value_state explicit_value_state NOT NULL,
  value boolean,
  source_url text NOT NULL,
  quoted_text text NOT NULL,
  locator jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL,
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(company_id, discovery_candidate_id) = 1),
  CHECK (
    (value_state = 'unknown' AND value IS NULL)
    OR (value_state = 'known' AND value IS NOT NULL)
    OR value_state = 'conflicting'
  ),
  CHECK (valid_to IS NULL OR valid_to > observed_at),
  UNIQUE NULLS NOT DISTINCT (
    company_id,
    discovery_candidate_id,
    signal_kind,
    source_url,
    quoted_text,
    valid_to
  )
);

COMMENT ON TABLE company_foreign_hiring_signals IS
  'Company-level discovery evidence only. It must never be materialized as a job-level fact.';

CREATE TABLE industry_codes (
  code text PRIMARY KEY,
  label_ja text NOT NULL,
  parent_code text REFERENCES industry_codes(code),
  priority corpus_priority NOT NULL DEFAULT 'p2'
);

CREATE TABLE company_industries (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  industry_code text NOT NULL REFERENCES industry_codes(code),
  source_url text NOT NULL,
  quoted_text text NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (company_id, industry_code, source_url)
);

CREATE TABLE source_discovery_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_discovery_candidate_id uuid NOT NULL REFERENCES company_discovery_candidates(id) ON DELETE CASCADE,
  source_kind source_kind NOT NULL,
  tenant_key text NOT NULL,
  collection_url text NOT NULL,
  official_referrer_url text,
  state discovery_candidate_state NOT NULL DEFAULT 'discovered',
  detected_at timestamptz NOT NULL,
  verified_at timestamptz,
  linked_source_instance_id uuid REFERENCES source_instances(id),
  UNIQUE (source_kind, tenant_key, collection_url),
  CHECK ((state = 'verified' AND linked_source_instance_id IS NOT NULL AND verified_at IS NOT NULL) OR state <> 'verified')
);

INSERT INTO discovery_sources (source_key, name, source_kind, base_url, policy_notes)
VALUES (
  'jetro-ofp',
  'JETRO Open for Professionals company list',
  'government_directory',
  'https://www.jetro.go.jp/hrportal/company/',
  'Discovery only. Do not store contact-person PII or treat listing as a current job fact.'
);

CREATE OR REPLACE FUNCTION set_default_source_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO source_schedules(source_instance_id,interval_hours,stale_refresh_allowed)
  VALUES (NEW.id,CASE NEW.source_kind WHEN 'greenhouse' THEN 12 ELSE 24 END,
    NEW.source_kind IN ('greenhouse','schema_org','hrmos'))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

COMMIT;
