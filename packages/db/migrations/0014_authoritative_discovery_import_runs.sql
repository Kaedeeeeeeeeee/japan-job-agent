BEGIN;

ALTER TABLE job_discovery_candidates
  ADD COLUMN last_authoritative_import_run_id uuid REFERENCES discovery_import_runs(id);

-- Authority written before this migration was asserted by individual records rather than a
-- finalized collection run. Keep the observations, but require a new successful snapshot before
-- those candidates count as fresh official-collection candidates again.
UPDATE job_discovery_candidates
SET last_authoritative_seen_at = NULL
WHERE last_authoritative_seen_at IS NOT NULL;

ALTER TABLE job_discovery_candidates
  ADD CONSTRAINT job_discovery_authority_requires_import_run CHECK (
    (last_authoritative_seen_at IS NULL AND last_authoritative_import_run_id IS NULL)
    OR (last_authoritative_seen_at IS NOT NULL AND last_authoritative_import_run_id IS NOT NULL)
  );

CREATE INDEX job_discovery_candidates_authoritative_run_fk_idx
  ON job_discovery_candidates(last_authoritative_import_run_id)
  WHERE last_authoritative_import_run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_job_discovery_authoritative_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_authoritative_import_run_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM discovery_import_runs run
    WHERE run.id = NEW.last_authoritative_import_run_id
      AND run.discovery_source_id = NEW.discovery_source_id
      AND run.status = 'succeeded'
      AND run.validation_result->>'snapshotKind' = 'authoritative'
      AND COALESCE((run.validation_result->>'allPagesCompleted')::boolean, false)
      AND COALESCE((run.validation_result->>'tenantIdentityConsistent')::boolean, false)
      AND COALESCE((run.validation_result->>'providerTotalMatched')::boolean, false)
      AND COALESCE(jsonb_array_length(run.validation_result->'parseErrors'), 0) = 0
      AND EXISTS (
        SELECT 1 FROM job_discovery_observations observation
        WHERE observation.candidate_id = NEW.id
          AND observation.discovery_import_run_id = run.id
      )
  ) THEN
    RAISE EXCEPTION 'job Discovery authority requires a successful, complete authoritative import run';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER job_discovery_authoritative_run_guard
BEFORE INSERT OR UPDATE OF discovery_source_id,last_authoritative_seen_at,last_authoritative_import_run_id
ON job_discovery_candidates FOR EACH ROW
EXECUTE FUNCTION validate_job_discovery_authoritative_run();

COMMIT;
