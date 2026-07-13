BEGIN;

CREATE TABLE source_job_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_instance_id uuid NOT NULL REFERENCES source_instances(id) ON DELETE CASCADE,
  stable_key text NOT NULL,
  external_id text,
  canonical_url text NOT NULL,
  lifecycle_state job_lifecycle_state NOT NULL DEFAULT 'active',
  missing_count integer NOT NULL DEFAULT 0 CHECK (missing_count >= 0),
  last_authoritative_missing_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (source_instance_id, stable_key)
);

CREATE TABLE source_job_company_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_job_record_id uuid NOT NULL REFERENCES source_job_records(id) ON DELETE CASCADE,
  company_source_relationship_id uuid NOT NULL REFERENCES company_source_relationships(id),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  UNIQUE NULLS NOT DISTINCT (source_job_record_id, company_source_relationship_id, valid_to)
);

CREATE TABLE source_job_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_job_record_id uuid NOT NULL REFERENCES source_job_records(id) ON DELETE CASCADE,
  source_sync_run_id uuid REFERENCES source_sync_runs(id) ON DELETE SET NULL,
  raw_hash char(64) NOT NULL CHECK (raw_hash ~ '^[0-9a-f]{64}$'),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  canonicalization_version text NOT NULL,
  raw_storage_key text NOT NULL,
  raw_byte_length bigint NOT NULL CHECK (raw_byte_length >= 0),
  content_type text,
  source_url text NOT NULL,
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  response_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_job_record_id, raw_hash)
);

COMMENT ON TABLE source_job_versions IS 'Immutable raw payload metadata only. Parser output is forbidden here.';

CREATE TABLE source_job_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_job_version_id uuid NOT NULL REFERENCES source_job_versions(id) ON DELETE CASCADE,
  parser_key text NOT NULL,
  parser_version text NOT NULL,
  schema_version text NOT NULL,
  status extraction_status NOT NULL,
  structured_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  extraction_hash char(64) CHECK (extraction_hash IS NULL OR extraction_hash ~ '^[0-9a-f]{64}$'),
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (source_job_version_id, parser_key, parser_version, schema_version),
  CHECK ((status = 'pending' AND completed_at IS NULL) OR status <> 'pending')
);

CREATE TABLE evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind evidence_kind NOT NULL,
  source_job_extraction_id uuid REFERENCES source_job_extractions(id) ON DELETE CASCADE,
  company_source_relationship_id uuid REFERENCES company_source_relationships(id) ON DELETE CASCADE,
  field_path text NOT NULL,
  quoted_text text NOT NULL,
  source_url text NOT NULL,
  locator jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_job_extraction_id IS NOT NULL OR company_source_relationship_id IS NOT NULL)
);

CREATE TABLE extraction_field_states (
  extraction_id uuid NOT NULL REFERENCES source_job_extractions(id) ON DELETE CASCADE,
  field_name text NOT NULL,
  value_state explicit_value_state NOT NULL,
  PRIMARY KEY (extraction_id, field_name)
);

CREATE TABLE extraction_employment_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id uuid NOT NULL REFERENCES source_job_extractions(id) ON DELETE CASCADE,
  employment_type text NOT NULL,
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  UNIQUE (extraction_id, employment_type, evidence_id)
);

CREATE TABLE extraction_residence_statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id uuid NOT NULL REFERENCES source_job_extractions(id) ON DELETE CASCADE,
  residence_status text NOT NULL,
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  UNIQUE (extraction_id, residence_status, evidence_id)
);

CREATE TABLE extraction_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id uuid NOT NULL REFERENCES source_job_extractions(id) ON DELETE CASCADE,
  country_code char(2),
  prefecture text,
  city text,
  address_text text,
  remote_scope text,
  evidence_id uuid NOT NULL REFERENCES evidence(id)
);

CREATE TABLE extraction_languages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id uuid NOT NULL REFERENCES source_job_extractions(id) ON DELETE CASCADE,
  language_code text NOT NULL,
  minimum_level text,
  requirement_kind text NOT NULL CHECK (requirement_kind IN ('required', 'preferred', 'mentioned')),
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  UNIQUE (extraction_id, language_code, requirement_kind, evidence_id)
);

CREATE TABLE extraction_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id uuid NOT NULL REFERENCES source_job_extractions(id) ON DELETE CASCADE,
  normalized_skill text NOT NULL,
  original_text text NOT NULL,
  requirement_kind text NOT NULL CHECK (requirement_kind IN ('required', 'preferred', 'mentioned')),
  evidence_id uuid NOT NULL REFERENCES evidence(id)
);

CREATE TABLE extraction_compensation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id uuid NOT NULL REFERENCES source_job_extractions(id) ON DELETE CASCADE,
  compensation_kind text NOT NULL CHECK (compensation_kind IN ('base', 'total', 'trial', 'bonus', 'other')),
  currency char(3) NOT NULL,
  period text NOT NULL CHECK (period IN ('hour', 'day', 'month', 'year')),
  minimum_amount numeric(16,2),
  maximum_amount numeric(16,2),
  is_calculated boolean NOT NULL DEFAULT false,
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  CHECK (minimum_amount IS NOT NULL OR maximum_amount IS NOT NULL),
  CHECK (minimum_amount IS NULL OR maximum_amount IS NULL OR minimum_amount <= maximum_amount)
);

CREATE TABLE extraction_mobility_facts (
  extraction_id uuid PRIMARY KEY REFERENCES source_job_extractions(id) ON DELETE CASCADE,
  visa_transfer_state explicit_value_state NOT NULL,
  relocation_support_state explicit_value_state NOT NULL,
  relocation_required_state explicit_value_state NOT NULL,
  transfer_required_state explicit_value_state NOT NULL,
  visa_transfer boolean,
  relocation_support boolean,
  relocation_required boolean,
  transfer_required boolean,
  CHECK ((visa_transfer_state = 'unknown' AND visa_transfer IS NULL) OR visa_transfer_state <> 'unknown'),
  CHECK ((relocation_support_state = 'unknown' AND relocation_support IS NULL) OR relocation_support_state <> 'unknown'),
  CHECK ((relocation_required_state = 'unknown' AND relocation_required IS NULL) OR relocation_required_state <> 'unknown'),
  CHECK ((transfer_required_state = 'unknown' AND transfer_required IS NULL) OR transfer_required_state <> 'unknown')
);

CREATE INDEX source_job_versions_content_hash_idx ON source_job_versions (content_hash);
CREATE INDEX extraction_skills_trgm_idx ON extraction_skills USING gin (normalized_skill gin_trgm_ops);

COMMIT;

