BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE source_kind AS ENUM ('greenhouse', 'schema_org', 'manual');
CREATE TYPE verification_state AS ENUM ('discovery', 'verified', 'rejected');
CREATE TYPE source_health_state AS ENUM ('healthy', 'degraded', 'blocked');
CREATE TYPE snapshot_kind AS ENUM ('authoritative', 'partial', 'single_record');
CREATE TYPE sync_status AS ENUM ('running', 'succeeded', 'failed');
CREATE TYPE extraction_status AS ENUM ('pending', 'succeeded', 'failed');
CREATE TYPE explicit_value_state AS ENUM ('known', 'unknown', 'conflicting');
CREATE TYPE job_lifecycle_state AS ENUM ('active', 'suspect', 'closed');
CREATE TYPE relationship_kind AS ENUM ('official_owner', 'official_recruiting_for', 'historical_owner');
CREATE TYPE evidence_kind AS ENUM ('official_domain', 'ats_link', 'field_quote', 'manual_confirmation', 'http_status');
CREATE TYPE review_task_state AS ENUM ('open', 'resolved', 'dismissed');

COMMIT;
