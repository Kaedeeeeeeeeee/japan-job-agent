# ADR-020: Job Discovery is isolated until verified promotion

Status: Accepted — 2026-07-15

## Context

Expanding from hundreds to ten thousand jobs requires broad public discovery. Search indexes and aggregators are useful leads, but they are not authoritative enough to change formal job lifecycle state or enter recommendations. Treating those rows as normal Source Jobs would reintroduce the stale and opaque-source failures this product is intended to avoid.

## Decision

- `job_discovery_candidates` and immutable `job_discovery_observations` are a separate trust boundary. They do not join recommendation or lifecycle queries.
- Official collection candidates count only when `last_authoritative_import_run_id` points to a succeeded Import Run whose validation proves every page completed, tenant identity consistency, provider-total agreement, and zero parse errors. The Orchestrator grants this authority after collection finalization; individual records cannot self-declare it. Authority remains fresh for 72 hours. Search and aggregator leads count only after two observations within 30 days.
- Location must deterministically resolve to Japan, a Japan-scoped remote role, or an application scope that explicitly includes Japan. Unknown and global remote do not count.
- Strong automatic identity is limited to ATS tenant plus posting ID, normalized official application URL, or normalized detail URL. Weak title/company/location similarity creates review clusters only.
- Promotion requires an exact Company–Source relationship backed by Evidence from an official corporate domain, a successful formal sync, immutable Raw, independent Extraction, field Evidence, active Lifecycle, and Canonical materialization.
- Promotion capacity uses a borrowable 50/25/25 queue: technology/product/e-commerce; consulting/HR; other industries. This changes processing order only, never Profile score or experience requirements.
- No single discovery source family may exceed 40% of valid candidates. Current expansion uses public ATS, Talentio, YOLO JAPAN, engage, and existing verified sources.

## Consequences

Candidate totals can grow quickly without polluting recommendations or causing false closures. Promotion is slower because official-domain backlink verification and full raw ingestion are required. This is intentional: discovery optimizes recall, while formal jobs optimize provenance and safety.
