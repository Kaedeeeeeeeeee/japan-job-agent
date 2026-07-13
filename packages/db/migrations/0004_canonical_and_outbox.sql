BEGIN;

CREATE TABLE canonical_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lifecycle_state job_lifecycle_state NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE canonical_job_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_job_id uuid NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
  materialization_version text NOT NULL,
  title text NOT NULL,
  application_url text NOT NULL,
  structured_result jsonb NOT NULL,
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (canonical_job_id, content_hash)
);

ALTER TABLE canonical_jobs ADD COLUMN current_version_id uuid REFERENCES canonical_job_versions(id);

CREATE TABLE canonical_job_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_job_id uuid NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
  source_job_record_id uuid NOT NULL REFERENCES source_job_records(id) ON DELETE CASCADE,
  source_role text NOT NULL CHECK (source_role IN ('primary', 'supporting')),
  active_from timestamptz NOT NULL DEFAULT now(),
  active_to timestamptz,
  merge_reason text NOT NULL,
  evidence_id uuid REFERENCES evidence(id),
  CHECK (active_to IS NULL OR active_to > active_from)
);

CREATE UNIQUE INDEX canonical_job_one_active_primary_source
  ON canonical_job_sources (canonical_job_id)
  WHERE source_role = 'primary' AND active_to IS NULL;
CREATE UNIQUE INDEX source_record_one_active_canonical
  ON canonical_job_sources (source_job_record_id)
  WHERE active_to IS NULL;

CREATE TABLE canonical_materialization_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_job_version_id uuid NOT NULL REFERENCES canonical_job_versions(id) ON DELETE CASCADE,
  source_job_extraction_id uuid NOT NULL REFERENCES source_job_extractions(id),
  input_role text NOT NULL CHECK (input_role IN ('primary', 'supporting')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (canonical_job_version_id, source_job_extraction_id)
);

CREATE UNIQUE INDEX canonical_version_one_primary_input
  ON canonical_materialization_inputs (canonical_job_version_id)
  WHERE input_role = 'primary';

CREATE TABLE temporal_activity_executions (
  activity_key text PRIMARY KEY,
  activity_type text NOT NULL,
  temporal_workflow_id text NOT NULL,
  temporal_run_id text NOT NULL,
  temporal_activity_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  result jsonb,
  locked_at timestamptz,
  lock_owner text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (temporal_workflow_id, temporal_run_id, temporal_activity_id)
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  dedup_key text NOT NULL UNIQUE,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lock_owner text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_events_claim_idx
  ON outbox_events (available_at, created_at)
  WHERE published_at IS NULL;

CREATE TABLE processed_outbox_events (
  consumer_name text NOT NULL,
  event_id uuid NOT NULL REFERENCES outbox_events(id) ON DELETE CASCADE,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, event_id)
);

CREATE TABLE job_state_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_job_record_id uuid NOT NULL REFERENCES source_job_records(id) ON DELETE CASCADE,
  from_state job_lifecycle_state,
  to_state job_lifecycle_state NOT NULL,
  source_sync_run_id uuid REFERENCES source_sync_runs(id),
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE data_quality_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  measured_at timestamptz NOT NULL DEFAULT now(),
  source_instance_id uuid REFERENCES source_instances(id) ON DELETE CASCADE,
  field_name text NOT NULL,
  known_count integer NOT NULL CHECK (known_count >= 0),
  unknown_count integer NOT NULL CHECK (unknown_count >= 0),
  conflicting_count integer NOT NULL CHECK (conflicting_count >= 0),
  non_unknown_with_evidence_count integer NOT NULL CHECK (non_unknown_with_evidence_count >= 0),
  CHECK (non_unknown_with_evidence_count <= known_count + conflicting_count)
);

COMMENT ON COLUMN data_quality_metrics.known_count IS 'Completeness numerator; reported separately from evidence integrity.';
COMMENT ON COLUMN data_quality_metrics.non_unknown_with_evidence_count IS 'Evidence integrity numerator for known and conflicting facts only.';

COMMIT;

