BEGIN;

CREATE TYPE fact_unknown_reason AS ENUM (
  'not_mentioned',
  'not_parsed',
  'unsupported_format',
  'low_confidence',
  'provider_failed'
);
CREATE TYPE job_readiness AS ENUM ('ready', 'pending_enrichment', 'needs_review');
CREATE TYPE extraction_origin AS ENUM ('deterministic', 'hybrid', 'manual');
CREATE TYPE ai_task_kind AS ENUM (
  'field_enrichment',
  'section_embedding',
  'job_embedding',
  'profile_embedding',
  'recommendation_explanation'
);
CREATE TYPE ai_task_state AS ENUM (
  'pending',
  'leased',
  'retryable_failed',
  'succeeded',
  'terminal_failed',
  'cancelled'
);
CREATE TYPE recommendation_explanation_status AS ENUM ('deterministic', 'pending', 'succeeded', 'failed');

ALTER TABLE extraction_field_states
  ADD COLUMN unknown_reason fact_unknown_reason;
UPDATE extraction_field_states SET unknown_reason='not_parsed' WHERE value_state='unknown';
ALTER TABLE extraction_field_states ADD CONSTRAINT extraction_field_unknown_reason_consistent CHECK (
  (value_state='unknown' AND unknown_reason IS NOT NULL)
  OR (value_state<>'unknown' AND unknown_reason IS NULL)
);

ALTER TABLE source_job_versions
  ADD CONSTRAINT source_job_versions_id_record_unique UNIQUE (id, source_job_record_id);
ALTER TABLE source_job_extractions
  ADD CONSTRAINT source_job_extractions_id_version_unique UNIQUE (id, source_job_version_id);

CREATE TABLE canonical_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_job_version_id uuid NOT NULL REFERENCES source_job_versions(id) ON DELETE CASCADE,
  adapter_key text NOT NULL,
  adapter_version text NOT NULL,
  title text NOT NULL,
  full_text text NOT NULL,
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_job_version_id, adapter_key, adapter_version)
);

CREATE TABLE canonical_document_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_document_id uuid NOT NULL REFERENCES canonical_documents(id) ON DELETE CASCADE,
  section_kind text NOT NULL CHECK (section_kind IN (
    'title','employment','location','compensation','responsibilities','required_requirements',
    'preferred_requirements','skills','languages','experience','dates','other'
  )),
  heading text,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  section_text text NOT NULL CHECK (length(section_text) > 0),
  locator jsonb NOT NULL,
  text_hash char(64) NOT NULL CHECK (text_hash ~ '^[0-9a-f]{64}$'),
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', left(coalesce(heading, '') || ' ' || section_text, 250000))
  ) STORED,
  UNIQUE (canonical_document_id, ordinal),
  UNIQUE (canonical_document_id, text_hash, ordinal)
);
CREATE INDEX canonical_document_sections_kind_idx
  ON canonical_document_sections (canonical_document_id, section_kind, ordinal);
CREATE INDEX canonical_document_sections_fts_idx
  ON canonical_document_sections USING gin (search_vector);

CREATE TABLE canonical_document_section_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_document_section_id uuid NOT NULL REFERENCES canonical_document_sections(id) ON DELETE CASCADE,
  model_key text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions > 0),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (canonical_document_section_id, model_key, content_hash),
  CHECK (vector_dims(embedding) = dimensions)
);
CREATE INDEX canonical_document_section_embeddings_lookup_idx
  ON canonical_document_section_embeddings (model_key, dimensions, canonical_document_section_id);

CREATE TABLE canonical_job_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_job_version_id uuid NOT NULL REFERENCES canonical_job_versions(id) ON DELETE CASCADE,
  model_key text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions > 0),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (canonical_job_version_id, model_key, content_hash),
  CHECK (vector_dims(embedding) = dimensions)
);
CREATE INDEX canonical_job_embeddings_lookup_idx
  ON canonical_job_embeddings (model_key, dimensions, canonical_job_version_id);

CREATE TABLE profile_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_version_id uuid NOT NULL REFERENCES profile_versions(id) ON DELETE CASCADE,
  model_key text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions > 0),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_version_id, model_key, content_hash),
  CHECK (vector_dims(embedding) = dimensions)
);
CREATE INDEX profile_embeddings_lookup_idx
  ON profile_embeddings (model_key, dimensions, profile_version_id);

CREATE TABLE source_job_extraction_lineage (
  extraction_id uuid PRIMARY KEY REFERENCES source_job_extractions(id) ON DELETE CASCADE,
  parent_extraction_id uuid REFERENCES source_job_extractions(id),
  origin extraction_origin NOT NULL,
  prompt_version text,
  model_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (origin='deterministic' AND parent_extraction_id IS NULL AND prompt_version IS NULL AND model_key IS NULL)
    OR (origin='hybrid' AND parent_extraction_id IS NOT NULL AND prompt_version IS NOT NULL AND model_key IS NOT NULL)
    OR (origin='manual' AND parent_extraction_id IS NOT NULL AND model_key IS NULL)
  )
);

INSERT INTO source_job_extraction_lineage(extraction_id, origin)
SELECT id, 'deterministic' FROM source_job_extractions
ON CONFLICT DO NOTHING;

CREATE TABLE source_job_extraction_heads (
  source_job_record_id uuid PRIMARY KEY REFERENCES source_job_records(id) ON DELETE CASCADE,
  source_job_version_id uuid NOT NULL,
  extraction_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_job_version_id, source_job_record_id)
    REFERENCES source_job_versions(id, source_job_record_id),
  FOREIGN KEY (extraction_id, source_job_version_id)
    REFERENCES source_job_extractions(id, source_job_version_id)
);

INSERT INTO source_job_extraction_heads(source_job_record_id, source_job_version_id, extraction_id)
SELECT DISTINCT ON (v.source_job_record_id)
  v.source_job_record_id, v.id, e.id
FROM source_job_versions v
JOIN source_job_extractions e ON e.source_job_version_id=v.id AND e.status='succeeded'
ORDER BY v.source_job_record_id, v.fetched_at DESC, e.completed_at DESC NULLS LAST, e.id DESC;

ALTER TABLE canonical_job_versions
  ADD COLUMN readiness job_readiness NOT NULL DEFAULT 'pending_enrichment',
  ADD COLUMN readiness_reasons text[] NOT NULL DEFAULT '{}'::text[];

UPDATE canonical_job_versions SET
  readiness = CASE
    WHEN structured_result->'employmentTypes'->>'state'='known'
      AND structured_result->'locations'->>'state'='known' THEN 'ready'::job_readiness
    WHEN structured_result->'employmentTypes'->>'state'='conflicting'
      OR structured_result->'locations'->>'state'='conflicting' THEN 'needs_review'::job_readiness
    ELSE 'pending_enrichment'::job_readiness
  END,
  readiness_reasons = ARRAY_REMOVE(ARRAY[
    CASE WHEN coalesce(structured_result->'employmentTypes'->>'state','unknown')<>'known'
      THEN 'employment_unresolved' END,
    CASE WHEN coalesce(structured_result->'locations'->>'state','unknown')<>'known'
      THEN 'location_unresolved' END
  ], NULL);

CREATE INDEX canonical_job_versions_readiness_idx
  ON canonical_job_versions (readiness, canonical_job_id, id);

CREATE TABLE field_review_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_job_version_id uuid NOT NULL REFERENCES source_job_versions(id) ON DELETE CASCADE,
  extraction_id uuid NOT NULL REFERENCES source_job_extractions(id) ON DELETE CASCADE,
  field_name text NOT NULL,
  reason fact_unknown_reason NOT NULL,
  state review_task_state NOT NULL DEFAULT 'open',
  candidate_quotes jsonb NOT NULL DEFAULT '[]'::jsonb,
  prompt_version text,
  model_key text,
  idempotency_key char(64) NOT NULL UNIQUE CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  resolution_extraction_id uuid REFERENCES source_job_extractions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK (
    (state='open' AND resolved_at IS NULL AND resolution_extraction_id IS NULL)
    OR (state<>'open' AND resolved_at IS NOT NULL)
  )
);
CREATE INDEX field_review_tasks_open_idx
  ON field_review_tasks (state, created_at, id) WHERE state='open';

CREATE TABLE ai_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_kind ai_task_kind NOT NULL,
  state ai_task_state NOT NULL DEFAULT 'pending',
  idempotency_key char(64) NOT NULL UNIQUE CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  provider_key text NOT NULL,
  model_key text NOT NULL,
  prompt_version text,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  last_error_code text,
  last_error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (
    (state='leased' AND lease_owner IS NOT NULL AND leased_at IS NOT NULL AND lease_expires_at>leased_at)
    OR (state<>'leased' AND lease_owner IS NULL AND leased_at IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (state IN ('succeeded','terminal_failed','cancelled') AND completed_at IS NOT NULL)
    OR (state NOT IN ('succeeded','terminal_failed','cancelled') AND completed_at IS NULL)
  )
);
CREATE INDEX ai_tasks_claim_idx
  ON ai_tasks (available_at, created_at, id)
  WHERE state IN ('pending','retryable_failed','leased');
CREATE INDEX ai_tasks_daily_budget_idx
  ON ai_tasks (provider_key, completed_at)
  WHERE state='succeeded';

CREATE TABLE recommendation_explanations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_version_id uuid NOT NULL REFERENCES profile_versions(id) ON DELETE CASCADE,
  canonical_job_version_id uuid NOT NULL REFERENCES canonical_job_versions(id) ON DELETE CASCADE,
  prompt_version text NOT NULL,
  model_key text NOT NULL,
  status recommendation_explanation_status NOT NULL DEFAULT 'pending',
  explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  input_hash char(64) NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (profile_version_id, canonical_job_version_id, prompt_version)
);

ALTER TABLE recommendation_runs
  ADD COLUMN retrieval_version text NOT NULL DEFAULT 'structured-all-v1',
  ADD COLUMN embedding_model_key text,
  ADD COLUMN input_job_version_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE recommendation_results
  ADD COLUMN explanation_status recommendation_explanation_status NOT NULL DEFAULT 'deterministic';

COMMIT;
