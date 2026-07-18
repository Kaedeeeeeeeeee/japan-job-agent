# ADR-021: Publication freshness controls admission and retention

Status: Accepted

## Context

The 10,000-candidate milestone optimized corpus size. The product now optimizes for newly published jobs. Observation time, source update time, sitemap `lastmod`, and first-seen time do not prove when a job was published and must not be substituted for a publication date.

## Decision

- A job is recommendation-eligible only when an evidence-backed publication date is `known` and falls within the inclusive six-calendar-month window in `Asia/Tokyo`.
- A newly discovered job with no trustworthy publication date enters a seven-day quarantine. It is stored for date enrichment but is not countable, promotable, or visible in recommendations.
- A known publication date older than the window, a future publication date, or an unknown date whose grace period elapsed is expired.
- Expired full content, observations, Canonical data, Raw metadata, and Raw objects are purged in bounded batches. A minimal SHA-256 identity/URL tombstone remains so the same stable posting is not fetched and stored again.
- A repost with the same stable source posting ID retains the original identity and cannot become new merely because it was observed or updated again. A new official posting ID with a trustworthy recent date is a new job.
- Daily metrics record new discoveries, recent/unknown/expired counts, tombstones, and pending Raw-object deletions.

## Consequences

Recommendation volume may fall while publication-date coverage improves. This is intentional: unknown and source-updated dates remain explicit rather than being guessed. Date extraction can be expanded only for fields whose semantics explicitly mean publication, such as `datePosted`, `datePublished`, `publishedAt`, or labeled Japanese publication dates.

Database deletion and object deletion cannot share one transaction. PostgreSQL therefore records Raw object keys in `raw_object_purge_queue` before deleting their database records; an idempotent worker deletes objects afterward and retries failures.
