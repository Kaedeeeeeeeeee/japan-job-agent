BEGIN;

ALTER TABLE extraction_mobility_facts
  ADD COLUMN visa_sponsorship_state explicit_value_state NOT NULL DEFAULT 'unknown',
  ADD COLUMN visa_sponsorship boolean;

ALTER TABLE extraction_mobility_facts
  ADD CONSTRAINT extraction_mobility_visa_sponsorship_explicit CHECK (
    (visa_sponsorship_state = 'unknown' AND visa_sponsorship IS NULL)
    OR (visa_sponsorship_state = 'known' AND visa_sponsorship IS NOT NULL)
    OR visa_sponsorship_state = 'conflicting'
  );

CREATE INDEX evidence_extraction_field_idx ON evidence (source_job_extraction_id, field_path);
CREATE INDEX source_job_lifecycle_reconcile_idx
  ON source_job_records (source_instance_id, lifecycle_state, last_authoritative_missing_at);

COMMIT;

