BEGIN;

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  display_name text NOT NULL,
  corporate_number text,
  verification_state verification_state NOT NULL DEFAULT 'discovery',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX companies_corporate_number_unique
  ON companies (corporate_number)
  WHERE corporate_number IS NOT NULL;

CREATE TABLE company_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  domain citext NOT NULL,
  is_official boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  verification_note text,
  UNIQUE (company_id, domain)
);

CREATE TABLE source_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind source_kind NOT NULL,
  tenant_key text NOT NULL,
  base_url text NOT NULL,
  verification_state verification_state NOT NULL DEFAULT 'discovery',
  health_state source_health_state NOT NULL DEFAULT 'healthy',
  last_success_at timestamptz,
  last_failure_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, tenant_key)
);

CREATE TABLE company_source_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_instance_id uuid NOT NULL REFERENCES source_instances(id) ON DELETE CASCADE,
  relationship_kind relationship_kind NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  verification_state verification_state NOT NULL DEFAULT 'discovery',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  UNIQUE NULLS NOT DISTINCT (company_id, source_instance_id, relationship_kind, valid_to)
);

CREATE TABLE source_policies (
  source_instance_id uuid PRIMARY KEY REFERENCES source_instances(id) ON DELETE CASCADE,
  requires_javascript boolean NOT NULL DEFAULT false,
  requires_cookies boolean NOT NULL DEFAULT false,
  allows_authoritative_snapshot boolean NOT NULL DEFAULT false,
  terms_url text,
  terms_reviewed_at timestamptz,
  owner_contact text,
  policy_notes text,
  minimum_missing_interval interval NOT NULL DEFAULT interval '12 hours',
  required_missing_count integer NOT NULL DEFAULT 2 CHECK (required_missing_count >= 1),
  closure_circuit_min_previous_active integer NOT NULL DEFAULT 5 CHECK (closure_circuit_min_previous_active >= 0),
  closure_circuit_max_missing_ratio numeric(6,5) NOT NULL DEFAULT 0.5 CHECK (closure_circuit_max_missing_ratio BETWEEN 0 AND 1),
  closure_circuit_max_missing_absolute integer NOT NULL DEFAULT 25 CHECK (closure_circuit_max_missing_absolute >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE source_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_instance_id uuid NOT NULL REFERENCES source_instances(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  temporal_workflow_id text,
  temporal_run_id text,
  status sync_status NOT NULL DEFAULT 'running',
  snapshot_kind snapshot_kind,
  page_count integer NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  provider_total integer CHECK (provider_total IS NULL OR provider_total >= 0),
  discovered_count integer NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  validation_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  circuit_breaker_reason text[],
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error_code text,
  error_detail text,
  UNIQUE (source_instance_id, idempotency_key),
  CHECK (
    (status = 'running' AND finished_at IS NULL)
    OR (status <> 'running' AND finished_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX source_sync_runs_temporal_execution_unique
  ON source_sync_runs (temporal_workflow_id, temporal_run_id)
  WHERE temporal_workflow_id IS NOT NULL AND temporal_run_id IS NOT NULL;

CREATE TABLE manual_review_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_instance_id uuid REFERENCES source_instances(id) ON DELETE CASCADE,
  source_sync_run_id uuid REFERENCES source_sync_runs(id) ON DELETE CASCADE,
  reason text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  state review_task_state NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

COMMIT;
