BEGIN;

ALTER TABLE source_job_records ADD COLUMN normalized_application_url text;
CREATE INDEX source_job_records_normalized_application_url_idx ON source_job_records (normalized_application_url)
  WHERE normalized_application_url IS NOT NULL;

CREATE TABLE canonical_merge_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_job_id uuid NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
  source_job_record_id uuid NOT NULL REFERENCES source_job_records(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('merge', 'unmerge', 'primary_switch')),
  rule text NOT NULL,
  evidence_id uuid REFERENCES evidence(id),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE canonical_field_evidence (
  canonical_job_version_id uuid NOT NULL REFERENCES canonical_job_versions(id) ON DELETE CASCADE,
  field_path text NOT NULL,
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  PRIMARY KEY (canonical_job_version_id, field_path, evidence_id)
);

CREATE TABLE profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_key text NOT NULL UNIQUE,
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profile_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  schema_version text NOT NULL,
  structured_profile jsonb NOT NULL,
  source_fingerprint char(64) NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  contains_direct_pii boolean NOT NULL DEFAULT false CHECK (contains_direct_pii = false),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, version),
  UNIQUE (profile_id, source_fingerprint)
);

ALTER TABLE profiles ADD CONSTRAINT profiles_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES profile_versions(id);

COMMIT;

