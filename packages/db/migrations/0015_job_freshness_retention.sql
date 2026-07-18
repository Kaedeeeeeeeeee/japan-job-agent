BEGIN;

CREATE TYPE job_publication_freshness AS ENUM ('recent', 'unknown_quarantine', 'expired');
CREATE TYPE raw_object_purge_state AS ENUM ('pending', 'leased', 'deleted', 'failed');

ALTER TABLE job_discovery_candidates
  ADD COLUMN publication_freshness job_publication_freshness,
  ADD COLUMN publication_check_due_at timestamptz,
  ADD COLUMN retention_expires_on date,
  ADD COLUMN identity_fingerprint char(64),
  ADD COLUMN normalized_detail_url_hash char(64),
  ADD COLUMN content_purged_at timestamptz;

UPDATE job_discovery_candidates
SET identity_fingerprint = encode(digest(
      CASE
        WHEN normalized_official_url IS NOT NULL THEN 'official:' || normalized_official_url
        WHEN tenant_key IS NOT NULL AND external_posting_id IS NOT NULL
          THEN 'external:' || source_family || ':' || tenant_key || ':' || external_posting_id
        ELSE 'detail:' || normalized_detail_url
      END,
      'sha256'
    ), 'hex'),
    normalized_detail_url_hash = encode(digest(normalized_detail_url, 'sha256'), 'hex'),
    publication_freshness = CASE
      WHEN source_published_precision IS NULL THEN 'unknown_quarantine'::job_publication_freshness
      WHEN COALESCE(source_published_date, (source_published_at AT TIME ZONE 'Asia/Tokyo')::date)
        BETWEEN (timezone('Asia/Tokyo', now())::date - interval '6 months')::date
          AND timezone('Asia/Tokyo', now())::date
        THEN 'recent'::job_publication_freshness
      ELSE 'expired'::job_publication_freshness
    END,
    publication_check_due_at = CASE WHEN source_published_precision IS NULL
      THEN first_seen_at + interval '7 days' ELSE NULL END,
    retention_expires_on = CASE WHEN source_published_precision IS NULL THEN NULL
      ELSE (COALESCE(source_published_date, (source_published_at AT TIME ZONE 'Asia/Tokyo')::date)
        + interval '6 months')::date END;

ALTER TABLE job_discovery_candidates
  ALTER COLUMN publication_freshness SET NOT NULL,
  ALTER COLUMN identity_fingerprint SET NOT NULL,
  ALTER COLUMN normalized_detail_url_hash SET NOT NULL,
  ADD CONSTRAINT job_discovery_identity_fingerprint_format CHECK (identity_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT job_discovery_detail_hash_format CHECK (normalized_detail_url_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT job_discovery_publication_quarantine_check CHECK (
    (publication_freshness = 'unknown_quarantine' AND source_published_precision IS NULL
      AND publication_check_due_at IS NOT NULL)
    OR publication_freshness <> 'unknown_quarantine'
  ),
  ADD CONSTRAINT job_discovery_recent_publication_check CHECK (
    publication_freshness <> 'recent'
    OR (source_published_precision IS NOT NULL AND publication_check_due_at IS NULL)
  ),
  ADD CONSTRAINT job_discovery_purged_state_check CHECK (
    content_purged_at IS NULL OR state = 'expired'
  );

CREATE INDEX job_discovery_candidates_recent_queue_idx
  ON job_discovery_candidates (state, priority, last_seen_at DESC, id)
  WHERE publication_freshness = 'recent' AND state IN ('discovered', 'resolving', 'resolved');
CREATE INDEX job_discovery_candidates_unknown_due_idx
  ON job_discovery_candidates (publication_check_due_at, id)
  WHERE publication_freshness = 'unknown_quarantine';
CREATE INDEX job_discovery_candidates_retention_date_idx
  ON job_discovery_candidates (retention_expires_on, id)
  WHERE publication_freshness = 'recent';
CREATE INDEX job_discovery_candidates_identity_fingerprint_idx
  ON job_discovery_candidates (identity_fingerprint);
CREATE INDEX job_discovery_candidates_detail_hash_idx
  ON job_discovery_candidates (normalized_detail_url_hash);

CREATE TABLE job_retention_tombstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_fingerprint char(64) NOT NULL UNIQUE CHECK (identity_fingerprint ~ '^[0-9a-f]{64}$'),
  normalized_detail_url_hash char(64) NOT NULL UNIQUE CHECK (normalized_detail_url_hash ~ '^[0-9a-f]{64}$'),
  source_family text NOT NULL,
  tenant_key text,
  external_posting_id text,
  source_published_date date,
  source_published_at timestamptz,
  source_published_precision job_date_precision,
  reason text NOT NULL,
  expired_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (source_published_precision IS NULL AND source_published_date IS NULL AND source_published_at IS NULL)
    OR (source_published_precision = 'date' AND source_published_date IS NOT NULL AND source_published_at IS NULL)
    OR (source_published_precision = 'datetime' AND source_published_date IS NULL AND source_published_at IS NOT NULL)
  )
);

CREATE INDEX job_retention_tombstones_source_identity_idx
  ON job_retention_tombstones (source_family, tenant_key, external_posting_id)
  WHERE tenant_key IS NOT NULL AND external_posting_id IS NOT NULL;

CREATE TABLE raw_object_purge_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_key text NOT NULL UNIQUE,
  state raw_object_purge_state NOT NULL DEFAULT 'pending',
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  leased_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (state = 'leased' AND lease_owner IS NOT NULL AND leased_at IS NOT NULL)
    OR (state <> 'leased' AND lease_owner IS NULL AND leased_at IS NULL)
  ),
  CHECK ((state = 'deleted' AND deleted_at IS NOT NULL) OR (state <> 'deleted' AND deleted_at IS NULL))
);

CREATE INDEX raw_object_purge_queue_claim_idx
  ON raw_object_purge_queue (available_at, created_at, id)
  WHERE state IN ('pending', 'failed', 'leased');

CREATE TABLE job_retention_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_version text NOT NULL,
  cutoff_date date NOT NULL,
  unknown_grace_days integer NOT NULL CHECK (unknown_grace_days BETWEEN 1 AND 30),
  batch_size integer NOT NULL CHECK (batch_size BETWEEN 1 AND 5000),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_detail text,
  CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR (status <> 'running' AND completed_at IS NOT NULL)
  )
);

CREATE TABLE job_freshness_daily_metrics (
  measured_on date PRIMARY KEY,
  measured_at timestamptz NOT NULL DEFAULT now(),
  retention_cutoff date NOT NULL,
  discovered_today integer NOT NULL CHECK (discovered_today >= 0),
  recent_candidates integer NOT NULL CHECK (recent_candidates >= 0),
  unknown_quarantine_candidates integer NOT NULL CHECK (unknown_quarantine_candidates >= 0),
  expired_candidates integer NOT NULL CHECK (expired_candidates >= 0),
  active_canonical_recent integer NOT NULL CHECK (active_canonical_recent >= 0),
  active_canonical_unknown integer NOT NULL CHECK (active_canonical_unknown >= 0),
  active_canonical_expired integer NOT NULL CHECK (active_canonical_expired >= 0),
  purged_candidates_total integer NOT NULL CHECK (purged_candidates_total >= 0),
  tombstones_total integer NOT NULL CHECK (tombstones_total >= 0),
  raw_objects_pending integer NOT NULL CHECK (raw_objects_pending >= 0)
);

CREATE INDEX canonical_job_dates_published_date_retention_idx
  ON canonical_job_dates (date_value, canonical_job_version_id)
  WHERE date_kind = 'published' AND precision = 'date';
CREATE INDEX canonical_job_dates_published_timestamp_retention_idx
  ON canonical_job_dates (timestamp_value, canonical_job_version_id)
  WHERE date_kind = 'published' AND precision = 'datetime';
CREATE INDEX source_job_records_active_first_seen_idx
  ON source_job_records (first_seen_at, id)
  WHERE lifecycle_state = 'active';

COMMENT ON TABLE job_retention_tombstones IS
  'Minimal non-content identity fingerprints retained after a job ages out, preventing repeated ingestion of the same posting.';
COMMENT ON TABLE raw_object_purge_queue IS
  'Transactional handoff for deleting raw objects after their expired database records have been removed.';
COMMENT ON TABLE job_freshness_daily_metrics IS
  'Daily Asia/Tokyo metrics for the six-calendar-month publication retention policy.';

COMMIT;
