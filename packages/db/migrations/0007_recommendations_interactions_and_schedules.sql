BEGIN;

CREATE TABLE recommendation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key text NOT NULL,
  run_key char(64) NOT NULL CHECK (run_key ~ '^[0-9a-f]{64}$'),
  profile_version_id uuid NOT NULL REFERENCES profile_versions(id),
  ranking_version text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  eligible_count integer NOT NULL CHECK (eligible_count >= 0),
  input_count integer NOT NULL CHECK (input_count >= eligible_count),
  UNIQUE (user_key, run_key)
);

CREATE TABLE recommendation_results (
  recommendation_run_id uuid NOT NULL REFERENCES recommendation_runs(id) ON DELETE CASCADE,
  canonical_job_id uuid NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
  canonical_job_version_id uuid NOT NULL REFERENCES canonical_job_versions(id),
  rank integer NOT NULL CHECK (rank >= 1),
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  eligible boolean NOT NULL,
  score_breakdown jsonb NOT NULL,
  explanation jsonb NOT NULL,
  PRIMARY KEY (recommendation_run_id, canonical_job_id),
  UNIQUE (recommendation_run_id, rank)
);

CREATE TABLE job_user_states (
  user_key text NOT NULL,
  canonical_job_id uuid NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
  saved boolean NOT NULL DEFAULT false,
  hidden boolean NOT NULL DEFAULT false,
  applied_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_key, canonical_job_id)
);

CREATE TABLE source_schedules (
  source_instance_id uuid PRIMARY KEY REFERENCES source_instances(id) ON DELETE CASCADE,
  interval_hours integer NOT NULL CHECK (interval_hours BETWEEN 1 AND 168),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  stale_refresh_allowed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION set_default_source_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO source_schedules(source_instance_id,interval_hours,stale_refresh_allowed)
  VALUES (NEW.id,CASE NEW.source_kind WHEN 'greenhouse' THEN 12 ELSE 24 END,
    NEW.source_kind IN ('greenhouse','schema_org'))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER source_instance_default_schedule
AFTER INSERT ON source_instances FOR EACH ROW EXECUTE FUNCTION set_default_source_schedule();

INSERT INTO source_schedules(source_instance_id, interval_hours, stale_refresh_allowed)
SELECT id, CASE source_kind WHEN 'greenhouse' THEN 12 ELSE 24 END,
  source_kind IN ('greenhouse', 'schema_org')
FROM source_instances
ON CONFLICT DO NOTHING;

CREATE TABLE company_seed_audits (
  seed_key text PRIMARY KEY,
  company_name text NOT NULL,
  pool text NOT NULL CHECK (pool IN ('direct', 'watch')),
  audit_state text NOT NULL CHECK (audit_state IN ('discovery', 'verified', 'no_current_job', 'blocked')),
  company_id uuid REFERENCES companies(id),
  source_instance_id uuid REFERENCES source_instances(id),
  official_domain text,
  current_job_count integer CHECK (current_job_count IS NULL OR current_job_count >= 0),
  evidence_url text,
  checked_at timestamptz,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX recommendation_results_visible_idx ON recommendation_results (recommendation_run_id, eligible, rank);
CREATE INDEX job_user_states_workflow_idx ON job_user_states (user_key, hidden, applied_at, updated_at DESC);
CREATE INDEX source_schedules_due_idx ON source_schedules (next_run_at);

COMMIT;
