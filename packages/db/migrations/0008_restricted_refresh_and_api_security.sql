BEGIN;

CREATE TABLE on_demand_refresh_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key text NOT NULL,
  canonical_job_id uuid NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
  source_instance_id uuid NOT NULL REFERENCES source_instances(id) ON DELETE CASCADE,
  request_key char(64) NOT NULL CHECK (request_key ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('requested', 'started', 'retrying', 'succeeded', 'failed')),
  temporal_workflow_id text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  failure_code text,
  failure_detail jsonb,
  UNIQUE (user_key, request_key),
  CHECK ((status = 'requested') = (temporal_workflow_id IS NULL)),
  CHECK (completed_at IS NULL OR status IN ('succeeded', 'failed'))
);

CREATE INDEX on_demand_refresh_source_audit_idx
  ON on_demand_refresh_requests (source_instance_id, requested_at DESC);
CREATE INDEX on_demand_refresh_user_audit_idx
  ON on_demand_refresh_requests (user_key, requested_at DESC);

COMMIT;
