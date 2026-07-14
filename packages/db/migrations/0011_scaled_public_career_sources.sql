ALTER TYPE source_kind ADD VALUE IF NOT EXISTS 'airwork';
ALTER TYPE source_kind ADD VALUE IF NOT EXISTS 'engage';
ALTER TYPE source_kind ADD VALUE IF NOT EXISTS 'talentio';

BEGIN;

CREATE OR REPLACE FUNCTION set_default_source_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO source_schedules(source_instance_id,interval_hours,stale_refresh_allowed)
  VALUES (NEW.id,CASE NEW.source_kind WHEN 'greenhouse' THEN 12 ELSE 24 END,
    NEW.source_kind IN ('greenhouse','schema_org','hrmos','herp','jobcan','airwork','engage','talentio'))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

COMMIT;
