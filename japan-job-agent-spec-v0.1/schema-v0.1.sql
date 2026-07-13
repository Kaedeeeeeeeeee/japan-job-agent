-- Japan Job Data & Recommendation Agent
-- PostgreSQL schema baseline v0.1
-- Target: PostgreSQL 16+
-- Generated: 2026-07-12

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- -----------------------------------------------------------------------------
-- Shared trigger
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- 1. Company Registry
-- -----------------------------------------------------------------------------
CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_kind TEXT NOT NULL CHECK (entity_kind IN (
    'japanese_legal_entity', 'foreign_legal_entity', 'public_body',
    'sole_proprietor', 'unknown'
  )),
  country_code CHAR(2) NOT NULL DEFAULT 'JP',
  legal_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  registry_status TEXT NOT NULL DEFAULT 'unknown' CHECK (registry_status IN (
    'active', 'closed', 'merged', 'dissolved', 'unknown'
  )),
  headquarters JSONB,
  incorporated_on DATE,
  dissolved_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_companies_normalized_name_trgm
  ON companies USING GIN (normalized_name gin_trgm_ops);
CREATE INDEX idx_companies_registry_status ON companies (registry_status);
CREATE TRIGGER trg_companies_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE company_identifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  identifier_type TEXT NOT NULL CHECK (identifier_type IN (
    'jp_corporate_number', 'lei', 'duns', 'provider_company_id', 'other'
  )),
  issuer TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  verification_state TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_state IN (
    'verified', 'unverified', 'conflicting', 'revoked'
  )),
  source_url TEXT,
  observed_at TIMESTAMPTZ NOT NULL,
  valid_from DATE,
  valid_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (identifier_type, issuer, identifier_value)
);
CREATE INDEX idx_company_identifiers_company ON company_identifiers (company_id);

CREATE TABLE company_names (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  name_type TEXT NOT NULL CHECK (name_type IN (
    'legal', 'trade_name', 'brand', 'former_name', 'english_name', 'alias'
  )),
  language_code TEXT,
  is_preferred BOOLEAN NOT NULL DEFAULT false,
  valid_from DATE,
  valid_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_company_names_company ON company_names (company_id);
CREATE INDEX idx_company_names_normalized_trgm
  ON company_names USING GIN (normalized_name gin_trgm_ops);

CREATE TABLE company_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  normalized_domain TEXT NOT NULL,
  domain_role TEXT NOT NULL CHECK (domain_role IN (
    'official', 'careers', 'product', 'email', 'investor_relations', 'other'
  )),
  verification_state TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_state IN (
    'verified', 'unverified', 'conflicting', 'expired'
  )),
  verification_method TEXT CHECK (verification_method IN (
    'registry_record', 'official_site_link', 'dns', 'email_domain',
    'manual_review', 'provider_metadata', 'other'
  )),
  verified_at TIMESTAMPTZ,
  last_observed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, normalized_domain, domain_role)
);
CREATE INDEX idx_company_domains_domain ON company_domains (normalized_domain);
CREATE INDEX idx_company_domains_company ON company_domains (company_id);

CREATE TABLE company_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  signal_type TEXT NOT NULL,
  polarity TEXT NOT NULL CHECK (polarity IN ('positive', 'neutral', 'negative')),
  severity SMALLINT CHECK (severity BETWEEN 0 AND 100),
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_name TEXT NOT NULL,
  source_url TEXT,
  evidence_text TEXT,
  observed_at TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_company_signals_company_type
  ON company_signals (company_id, signal_type);
CREATE INDEX idx_company_signals_valid_until ON company_signals (valid_until);

-- -----------------------------------------------------------------------------
-- 2. Source Relationship
-- -----------------------------------------------------------------------------
CREATE TABLE source_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  provider_kind TEXT NOT NULL CHECK (provider_kind IN (
    'ats', 'official_site', 'partner_feed', 'aggregator',
    'public_registry', 'manual'
  )),
  default_trust_score SMALLINT NOT NULL CHECK (default_trust_score BETWEEN 0 AND 100),
  supports_authoritative_snapshot BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_source_providers_updated_at
  BEFORE UPDATE ON source_providers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE source_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES source_providers(id),
  instance_key TEXT NOT NULL,
  canonical_base_url TEXT NOT NULL,
  access_mode TEXT NOT NULL CHECK (access_mode IN (
    'public_api', 'public_html', 'partner_feed', 'authenticated_api', 'manual'
  )),
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN (
    'active', 'degraded', 'blocked', 'disabled', 'retired'
  )),
  connector_key TEXT NOT NULL,
  connector_version TEXT NOT NULL,
  secret_reference TEXT,
  poll_interval_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (poll_interval_seconds >= 60),
  next_poll_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  terms_checked_at TIMESTAMPTZ,
  robots_checked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, instance_key)
);
CREATE INDEX idx_source_instances_next_poll
  ON source_instances (next_poll_at)
  WHERE lifecycle_status = 'active';
CREATE TRIGGER trg_source_instances_updated_at
  BEFORE UPDATE ON source_instances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE source_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_instance_id UUID NOT NULL UNIQUE REFERENCES source_instances(id),
  minimum_poll_interval_seconds INTEGER NOT NULL DEFAULT 3600
    CHECK (minimum_poll_interval_seconds >= 60),
  request_timeout_ms INTEGER NOT NULL DEFAULT 20000
    CHECK (request_timeout_ms BETWEEN 1000 AND 120000),
  max_response_bytes BIGINT NOT NULL DEFAULT 10485760
    CHECK (max_response_bytes BETWEEN 1024 AND 104857600),
  max_redirects SMALLINT NOT NULL DEFAULT 5 CHECK (max_redirects BETWEEN 0 AND 20),
  concurrency_per_host SMALLINT NOT NULL DEFAULT 2
    CHECK (concurrency_per_host BETWEEN 1 AND 20),
  required_missing_snapshots SMALLINT NOT NULL DEFAULT 2
    CHECK (required_missing_snapshots BETWEEN 1 AND 10),
  minimum_absence_interval_minutes INTEGER NOT NULL DEFAULT 30
    CHECK (minimum_absence_interval_minutes >= 0),
  robots_policy TEXT NOT NULL DEFAULT 'respect' CHECK (robots_policy IN (
    'respect', 'manual_review', 'disabled'
  )),
  allowed_storage_mode TEXT NOT NULL DEFAULT 'full_raw' CHECK (allowed_storage_mode IN (
    'full_raw', 'structured_only', 'metadata_only', 'disabled'
  )),
  allowed_display_mode TEXT NOT NULL DEFAULT 'summary_and_link' CHECK (allowed_display_mode IN (
    'full', 'summary_and_link', 'link_only', 'disabled'
  )),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_source_policies_updated_at
  BEFORE UPDATE ON source_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE company_source_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  source_instance_id UUID NOT NULL REFERENCES source_instances(id),
  relationship_type TEXT NOT NULL CHECK (relationship_type IN (
    'official_career_site', 'official_ats_tenant', 'group_career_portal',
    'authorized_partner_feed', 'recruitment_agency_source', 'discovery_source'
  )),
  company_role TEXT NOT NULL CHECK (company_role IN (
    'employer', 'recruiter', 'publisher', 'group_owner'
  )),
  verification_state TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_state IN (
    'verified', 'provisional', 'unverified', 'conflicting', 'expired', 'revoked'
  )),
  confidence NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  priority SMALLINT NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  verified_at TIMESTAMPTZ,
  last_observed_at TIMESTAMPTZ,
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, source_instance_id, relationship_type, company_role)
);
CREATE INDEX idx_company_source_relationships_company
  ON company_source_relationships (company_id);
CREATE INDEX idx_company_source_relationships_source
  ON company_source_relationships (source_instance_id);
CREATE TRIGGER trg_company_source_relationships_updated_at
  BEFORE UPDATE ON company_source_relationships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE source_relationship_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id UUID NOT NULL REFERENCES company_source_relationships(id),
  evidence_type TEXT NOT NULL CHECK (evidence_type IN (
    'official_outbound_link', 'official_domain_match', 'provider_metadata_match',
    'job_apply_link', 'company_disclosure', 'manual_review', 'other'
  )),
  source_url TEXT,
  target_url TEXT,
  evidence_text TEXT,
  evidence_blob_uri TEXT,
  content_hash TEXT,
  confidence NUMERIC(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_source_relationship_evidence_relationship
  ON source_relationship_evidence (relationship_id, observed_at DESC);

CREATE TABLE source_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_instance_id UUID NOT NULL REFERENCES source_instances(id),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  run_status TEXT NOT NULL CHECK (run_status IN (
    'running', 'success', 'partial', 'failed', 'cancelled'
  )),
  snapshot_scope TEXT NOT NULL CHECK (snapshot_scope IN (
    'authoritative', 'partial', 'delta', 'single_record'
  )),
  connector_version TEXT NOT NULL,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  missing_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  cursor_before JSONB,
  cursor_after JSONB,
  error_details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_source_sync_runs_source_started
  ON source_sync_runs (source_instance_id, started_at DESC);

-- -----------------------------------------------------------------------------
-- 3. Source Job Record
-- -----------------------------------------------------------------------------
CREATE TABLE source_job_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_instance_id UUID NOT NULL REFERENCES source_instances(id),
  source_identity_key TEXT NOT NULL,
  native_job_id TEXT,
  identity_strategy TEXT NOT NULL CHECK (identity_strategy IN (
    'provider_job_id', 'canonical_url', 'normalized_url_hash', 'composite_key'
  )),
  source_url TEXT NOT NULL,
  canonical_source_url TEXT,
  apply_url TEXT,
  current_status TEXT NOT NULL DEFAULT 'active' CHECK (current_status IN (
    'active', 'suspect', 'closed', 'archived', 'unknown'
  )),
  current_version_id UUID,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  last_verified_at TIMESTAMPTZ NOT NULL,
  last_seen_sync_run_id UUID REFERENCES source_sync_runs(id),
  missing_authoritative_snapshots INTEGER NOT NULL DEFAULT 0,
  closed_detected_at TIMESTAMPTZ,
  closure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_instance_id, source_identity_key)
);
CREATE INDEX idx_source_job_records_source_status
  ON source_job_records (source_instance_id, current_status);
CREATE INDEX idx_source_job_records_last_verified
  ON source_job_records (last_verified_at);
CREATE TRIGGER trg_source_job_records_updated_at
  BEFORE UPDATE ON source_job_records
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE source_job_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_job_record_id UUID NOT NULL REFERENCES source_job_records(id),
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  observed_in_sync_run_id UUID REFERENCES source_sync_runs(id),
  observed_at TIMESTAMPTZ NOT NULL,
  content_hash TEXT NOT NULL,
  source_url TEXT NOT NULL,
  apply_url TEXT,
  raw_format TEXT NOT NULL CHECK (raw_format IN (
    'json', 'html', 'xml', 'text', 'manual'
  )),
  raw_blob_uri TEXT,
  raw_payload JSONB,
  raw_text TEXT,
  extracted_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  parser_key TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  source_published_at TIMESTAMPTZ,
  source_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_job_record_id, version_number),
  CHECK (raw_blob_uri IS NOT NULL OR raw_payload IS NOT NULL OR raw_text IS NOT NULL)
);
CREATE INDEX idx_source_job_versions_record
  ON source_job_versions (source_job_record_id, version_number DESC);
CREATE INDEX idx_source_job_versions_content_hash
  ON source_job_versions (content_hash);
ALTER TABLE source_job_records
  ADD CONSTRAINT fk_source_job_current_version
  FOREIGN KEY (current_version_id) REFERENCES source_job_versions(id);

CREATE TABLE source_job_status_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_job_record_id UUID NOT NULL REFERENCES source_job_records(id),
  previous_status TEXT,
  new_status TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason_details JSONB,
  sync_run_id UUID REFERENCES source_sync_runs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_source_job_status_events_record
  ON source_job_status_events (source_job_record_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 4. Canonical Job
-- -----------------------------------------------------------------------------
CREATE TABLE canonical_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recruiting_company_id UUID NOT NULL REFERENCES companies(id),
  employing_company_id UUID REFERENCES companies(id),
  current_status TEXT NOT NULL DEFAULT 'active' CHECK (current_status IN (
    'active', 'suspect', 'closed', 'archived'
  )),
  primary_source_job_record_id UUID REFERENCES source_job_records(id),
  current_version_id UUID,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_verified_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  closure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_canonical_jobs_status_verified
  ON canonical_jobs (current_status, last_verified_at DESC);
CREATE INDEX idx_canonical_jobs_employer ON canonical_jobs (employing_company_id);
CREATE TRIGGER trg_canonical_jobs_updated_at
  BEFORE UPDATE ON canonical_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE canonical_job_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id),
  source_job_record_id UUID NOT NULL REFERENCES source_job_records(id),
  source_role TEXT NOT NULL CHECK (source_role IN (
    'primary', 'official_mirror', 'translation', 'migration_copy',
    'authorized_secondary', 'aggregator_copy'
  )),
  match_method TEXT NOT NULL CHECK (match_method IN (
    'same_provider_identity', 'same_apply_url', 'same_requisition_id',
    'official_link', 'fuzzy_match', 'manual'
  )),
  match_score NUMERIC(5,4) NOT NULL CHECK (match_score BETWEEN 0 AND 1),
  match_features JSONB NOT NULL DEFAULT '{}'::jsonb,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  unlinked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_active_source_job_mapping
  ON canonical_job_sources (source_job_record_id)
  WHERE unlinked_at IS NULL;
CREATE INDEX idx_canonical_job_sources_canonical
  ON canonical_job_sources (canonical_job_id)
  WHERE unlinked_at IS NULL;
CREATE UNIQUE INDEX uq_active_primary_source_per_canonical_job
  ON canonical_job_sources (canonical_job_id)
  WHERE unlinked_at IS NULL AND source_role = 'primary';

CREATE TABLE canonical_job_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id),
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  department TEXT,
  job_family_code TEXT,
  seniority_level TEXT,
  employment_type TEXT CHECK (employment_type IN (
    'permanent', 'fixed_term', 'contractor', 'temporary', 'part_time',
    'internship', 'new_graduate', 'unknown'
  )),
  work_arrangement TEXT CHECK (work_arrangement IN (
    'onsite', 'hybrid', 'remote', 'unknown'
  )),
  description_text TEXT,
  responsibilities_text TEXT,
  requirements_text TEXT,
  min_experience_months INTEGER CHECK (min_experience_months IS NULL OR min_experience_months >= 0),
  max_experience_months INTEGER CHECK (max_experience_months IS NULL OR max_experience_months >= 0),
  visa_support TEXT NOT NULL DEFAULT 'unknown' CHECK (visa_support IN (
    'yes', 'no', 'case_by_case', 'unknown', 'conflicting'
  )),
  overseas_application TEXT NOT NULL DEFAULT 'unknown' CHECK (overseas_application IN (
    'yes', 'no', 'case_by_case', 'unknown', 'conflicting'
  )),
  residence_in_japan_required TEXT NOT NULL DEFAULT 'unknown' CHECK (residence_in_japan_required IN (
    'yes', 'no', 'unknown', 'conflicting'
  )),
  application_deadline TIMESTAMPTZ,
  structured_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  materialization_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (canonical_job_id, version_number),
  CHECK (
    min_experience_months IS NULL OR max_experience_months IS NULL
    OR min_experience_months <= max_experience_months
  )
);
CREATE INDEX idx_canonical_job_versions_title_trgm
  ON canonical_job_versions USING GIN (normalized_title gin_trgm_ops);
CREATE INDEX idx_canonical_job_versions_payload
  ON canonical_job_versions USING GIN (structured_payload);
ALTER TABLE canonical_jobs
  ADD CONSTRAINT fk_canonical_job_current_version
  FOREIGN KEY (current_version_id) REFERENCES canonical_job_versions(id);

CREATE TABLE canonical_job_version_inputs (
  canonical_job_version_id UUID NOT NULL REFERENCES canonical_job_versions(id),
  source_job_version_id UUID NOT NULL REFERENCES source_job_versions(id),
  source_priority SMALLINT NOT NULL CHECK (source_priority BETWEEN 0 AND 100),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (canonical_job_version_id, source_job_version_id)
);

CREATE TABLE canonical_job_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_job_version_id UUID NOT NULL REFERENCES canonical_job_versions(id),
  country_code CHAR(2),
  region TEXT,
  city TEXT,
  address_text TEXT,
  location_role TEXT NOT NULL DEFAULT 'primary' CHECK (location_role IN ('primary', 'alternate')),
  work_mode TEXT CHECK (work_mode IN ('onsite', 'hybrid', 'remote', 'unknown')),
  remote_scope TEXT CHECK (remote_scope IN (
    'japan_only', 'specific_regions', 'worldwide', 'unknown'
  )),
  onsite_days_min NUMERIC(3,1),
  onsite_days_max NUMERIC(3,1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    onsite_days_min IS NULL OR onsite_days_max IS NULL
    OR onsite_days_min <= onsite_days_max
  )
);
CREATE INDEX idx_canonical_job_locations_version
  ON canonical_job_locations (canonical_job_version_id);

CREATE TABLE canonical_job_language_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_job_version_id UUID NOT NULL REFERENCES canonical_job_versions(id),
  language_code TEXT NOT NULL,
  requirement_type TEXT NOT NULL CHECK (requirement_type IN (
    'required', 'preferred', 'working_language'
  )),
  level_system TEXT CHECK (level_system IN (
    'jlpt', 'cefr', 'native', 'business', 'free_text', 'unknown'
  )),
  level_code TEXT,
  raw_requirement TEXT NOT NULL,
  confidence NUMERIC(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_canonical_job_language_version
  ON canonical_job_language_requirements (canonical_job_version_id);

CREATE TABLE skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  skill_category TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE canonical_job_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_job_version_id UUID NOT NULL REFERENCES canonical_job_versions(id),
  skill_id UUID REFERENCES skills(id),
  raw_skill_name TEXT NOT NULL,
  requirement_type TEXT NOT NULL CHECK (requirement_type IN (
    'required', 'preferred', 'mentioned'
  )),
  min_experience_months INTEGER,
  confidence NUMERIC(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_canonical_job_skills_version
  ON canonical_job_skills (canonical_job_version_id);
CREATE INDEX idx_canonical_job_skills_skill
  ON canonical_job_skills (skill_id);

CREATE TABLE canonical_job_compensation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_job_version_id UUID NOT NULL REFERENCES canonical_job_versions(id),
  component_type TEXT NOT NULL CHECK (component_type IN (
    'total', 'base', 'bonus', 'allowance', 'equity', 'other'
  )),
  currency CHAR(3) NOT NULL,
  pay_period TEXT NOT NULL CHECK (pay_period IN ('hour', 'day', 'month', 'year')),
  amount_min NUMERIC(16,2),
  amount_max NUMERIC(16,2),
  fixed_overtime_included BOOLEAN,
  fixed_overtime_hours_min NUMERIC(6,2),
  fixed_overtime_hours_max NUMERIC(6,2),
  fixed_overtime_amount NUMERIC(16,2),
  raw_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (amount_min IS NULL OR amount_max IS NULL OR amount_min <= amount_max),
  CHECK (
    fixed_overtime_hours_min IS NULL OR fixed_overtime_hours_max IS NULL
    OR fixed_overtime_hours_min <= fixed_overtime_hours_max
  )
);
CREATE INDEX idx_canonical_job_compensation_version
  ON canonical_job_compensation (canonical_job_version_id);

CREATE TABLE job_field_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_job_version_id UUID NOT NULL REFERENCES canonical_job_versions(id),
  field_path TEXT NOT NULL,
  source_job_version_id UUID NOT NULL REFERENCES source_job_versions(id),
  evidence_text TEXT NOT NULL,
  evidence_start_offset INTEGER,
  evidence_end_offset INTEGER,
  evidence_url TEXT,
  extraction_method TEXT NOT NULL CHECK (extraction_method IN (
    'structured_api', 'json_ld', 'deterministic_parser', 'rule_based', 'llm', 'manual'
  )),
  confidence NUMERIC(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    evidence_start_offset IS NULL OR evidence_end_offset IS NULL
    OR (
      evidence_start_offset >= 0
      AND evidence_end_offset >= evidence_start_offset
    )
  )
);
CREATE INDEX idx_job_field_evidence_job_field
  ON job_field_evidence (canonical_job_version_id, field_path);

CREATE TABLE job_dedup_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  left_source_job_record_id UUID NOT NULL REFERENCES source_job_records(id),
  right_source_job_record_id UUID NOT NULL REFERENCES source_job_records(id),
  duplicate_score NUMERIC(5,4) NOT NULL CHECK (duplicate_score BETWEEN 0 AND 1),
  features JSONB NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN (
    'pending', 'same_job', 'different_job', 'translation',
    'migration_copy', 'uncertain'
  )),
  decision_method TEXT CHECK (decision_method IN ('rule', 'model', 'manual')),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (left_source_job_record_id < right_source_job_record_id),
  UNIQUE (left_source_job_record_id, right_source_job_record_id)
);
CREATE INDEX idx_job_dedup_candidates_pending
  ON job_dedup_candidates (duplicate_score DESC)
  WHERE decision = 'pending';

CREATE TABLE job_embeddings (
  canonical_job_version_id UUID NOT NULL REFERENCES canonical_job_versions(id),
  model_key TEXT NOT NULL,
  embedding vector NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (canonical_job_version_id, model_key)
);
-- Add a model-specific HNSW index in a later migration after the embedding
-- dimension and distance metric have been selected.

-- -----------------------------------------------------------------------------
-- Candidate profile, recommendation and feedback
-- -----------------------------------------------------------------------------
CREATE TABLE candidate_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_key TEXT NOT NULL UNIQUE,
  current_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_candidate_profiles_updated_at
  BEFORE UPDATE ON candidate_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE candidate_profile_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_profile_id UUID NOT NULL REFERENCES candidate_profiles(id),
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  current_country CHAR(2),
  current_region TEXT,
  current_city TEXT,
  residence_status TEXT,
  requires_visa_sponsorship BOOLEAN,
  desired_job_families JSONB NOT NULL DEFAULT '[]'::jsonb,
  desired_locations JSONB NOT NULL DEFAULT '[]'::jsonb,
  desired_employment_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  salary_floor JSONB,
  hard_constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
  soft_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  languages JSONB NOT NULL DEFAULT '[]'::jsonb,
  exclusions JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_resume_blob_uri TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (candidate_profile_id, version_number)
);
ALTER TABLE candidate_profiles
  ADD CONSTRAINT fk_candidate_profile_current_version
  FOREIGN KEY (current_version_id) REFERENCES candidate_profile_versions(id);

CREATE TABLE recommendation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_profile_version_id UUID NOT NULL REFERENCES candidate_profile_versions(id),
  query_text TEXT,
  filter_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ranker_version TEXT NOT NULL,
  embedding_model_version TEXT,
  prompt_version TEXT,
  llm_model TEXT,
  run_status TEXT NOT NULL CHECK (run_status IN ('running', 'success', 'failed', 'cancelled')),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX idx_recommendation_runs_profile
  ON recommendation_runs (candidate_profile_version_id, created_at DESC);

CREATE TABLE recommendation_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_run_id UUID NOT NULL REFERENCES recommendation_runs(id),
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id),
  canonical_job_version_id UUID NOT NULL REFERENCES canonical_job_versions(id),
  rank INTEGER NOT NULL CHECK (rank >= 1),
  total_score NUMERIC(8,4) NOT NULL,
  feature_scores JSONB NOT NULL,
  hard_filter_result JSONB NOT NULL,
  explanation_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recommendation_run_id, canonical_job_id),
  UNIQUE (recommendation_run_id, rank)
);
CREATE INDEX idx_recommendation_items_run_rank
  ON recommendation_items (recommendation_run_id, rank);

CREATE TABLE feedback_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_profile_id UUID NOT NULL REFERENCES candidate_profiles(id),
  canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id),
  canonical_job_version_id UUID REFERENCES canonical_job_versions(id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'viewed', 'saved', 'hidden', 'opened_official_page',
    'started_application', 'applied', 'interview', 'rejected',
    'offer', 'accepted'
  )),
  reason_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_feedback_events_profile_time
  ON feedback_events (candidate_profile_id, created_at DESC);
CREATE INDEX idx_feedback_events_job
  ON feedback_events (canonical_job_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- Operational support
-- -----------------------------------------------------------------------------
CREATE TABLE manual_review_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  priority SMALLINT NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  reason_code TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'in_progress', 'resolved', 'dismissed'
  )),
  resolution JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX idx_manual_review_queue_open
  ON manual_review_queue (priority DESC, created_at)
  WHERE status IN ('open', 'in_progress');
CREATE TRIGGER trg_manual_review_queue_updated_at
  BEFORE UPDATE ON manual_review_queue
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX idx_outbox_events_unpublished
  ON outbox_events (occurred_at)
  WHERE published_at IS NULL;

COMMIT;
