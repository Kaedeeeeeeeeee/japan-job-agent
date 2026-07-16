ALTER TYPE source_kind ADD VALUE IF NOT EXISTS 'herp';
ALTER TYPE source_kind ADD VALUE IF NOT EXISTS 'jobcan';

BEGIN;

CREATE TYPE company_promotion_status AS ENUM (
  'pending',
  'promoted_active',
  'verified_no_current_job',
  'unsupported_source',
  'unstructured_career_page',
  'insecure_source',
  'unreachable'
);

CREATE TABLE company_promotion_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_discovery_candidate_id uuid NOT NULL REFERENCES company_discovery_candidates(id) ON DELETE CASCADE,
  audit_key text NOT NULL,
  status company_promotion_status NOT NULL DEFAULT 'pending',
  official_site_url text,
  recruitment_url text,
  final_recruitment_url text,
  transport_secure boolean,
  http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  detected_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  current_job_count integer CHECK (current_job_count IS NULL OR current_job_count >= 0),
  linked_company_id uuid REFERENCES companies(id),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  audited_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_discovery_candidate_id, audit_key),
  CHECK ((status = 'promoted_active' AND linked_company_id IS NOT NULL AND current_job_count > 0) OR status <> 'promoted_active')
);

CREATE INDEX company_promotion_audits_status_idx ON company_promotion_audits(status, audited_at DESC);

CREATE TABLE company_discovery_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_discovery_candidate_id uuid NOT NULL REFERENCES company_discovery_candidates(id) ON DELETE CASCADE,
  evidence_type text NOT NULL CHECK (evidence_type IN ('directory_company_site', 'directory_recruitment_link', 'career_source_link', 'live_source_result')),
  source_url text NOT NULL,
  target_url text,
  quoted_text text NOT NULL,
  locator jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_discovery_candidate_id, evidence_type, source_url, quoted_text)
);

CREATE OR REPLACE FUNCTION set_default_source_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO source_schedules(source_instance_id,interval_hours,stale_refresh_allowed)
  VALUES (NEW.id,CASE NEW.source_kind WHEN 'greenhouse' THEN 12 ELSE 24 END,
    NEW.source_kind IN ('greenhouse','schema_org','hrmos','herp','jobcan'))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

COMMIT;
