# Week 4: deterministic ranking, private UI, and cloud operations

- Fixed 100-point ranking: role 25, skills 25, language 15, channel 10, location 10, employment 5, compensation 5, freshness/source 5.
- Hard rejection remains limited to inactive, unverified, explicitly excluded employment, and explicit location conflict.
- Parser 1.3 extracts evidence-backed experience-year requirements; they appear as gaps and lower the recruitment-channel score without becoming hard filters.
- Next.js UI is protected by GitHub single-user auth in production. Local bypass requires `AUTH_BYPASS_LOCAL=true` and is disabled when `NODE_ENV=production`.
- Temporal schedules are 12 hours for Greenhouse and 24 hours for schema.org. Activity executions use database leases and persisted results for retry idempotency.
- Logical backup and isolated restore verification are executable scripts; Railway deployment remains blocked until a local operator authenticates the CLI and supplies company-owned OAuth credentials.

The browser acceptance screenshot is `output/playwright/week4-real-dashboard.png`; it was generated from the real local PostgreSQL 16 chain, not fixture data.

## 2026-07-13 acceptance snapshot

- 16 seed companies audited; 11 verified company/source relationships.
- 3 verified Greenhouse tenants: PayPay 86, PayPay Card 42, PayPay Securities 17 active jobs.
- 2 verified schema.org records; 147 active Canonical Jobs total.
- 147 unique Source Records and 148 unique Raw Versions after a live Temporal refresh.
- Parser 1.3 replayed 147 Raw Versions successfully and produced 801 evidence candidates.
- Zero non-unknown evidence gaps across employment, visa, location, language, and compensation; zero erroneous closures.
- Temporal live retry recovered from a persisted failed execution and completed the same Activity once.
- PostgreSQL 16 custom backup (1,856,839 bytes) restored into an isolated database with all 7 migrations, 11 sources, and 147 Canonical Jobs.

Cloud creation was not attempted without operator authentication: `railway whoami` returns unauthorized. The runbook and containers are ready, but Railway project creation, Bucket credentials, GitHub OAuth, managed backups, and the JPY 5,000 alert require a company-owned authenticated Railway session.

## Post-acceptance hardening

- Production API access is protected independently with a server-only internal Bearer token; `/health` is the only public route and production startup fails closed without a 32+ character token.
- Saved or applied stale jobs can request an audited on-demand Temporal refresh. Verified source relationship, active lifecycle, source policy, 12/24-hour staleness, and a one-hour source request key are enforced by the API, not inferred by the UI.
- Freshness uses `source_job_records.last_seen_at`. This advances after a successful unchanged response while immutable Raw Version count remains stable.
- A real schema.org job completed the local path `202 -> started -> succeeded`; its official confirmation timestamp advanced and an immediate repeat returned `source_not_stale`.
- A simulated API crash window left an hourly request at `requested`; the next call recovered it with the same request ID and deterministic Workflow ID, then completed a real PayPay full sync as `succeeded`.
- A non-existent Source drill failed the Pipeline as expected; the Workflow failure Finalizer moved the audit to `failed`, set `completed_at`, and recorded a terminal Pipeline failure instead of leaving it at `retrying`.
- Playwright verified the saved-job refresh interaction at 1440×1000 and 390×844. Stable screenshots are `output/playwright/restricted-refresh-complete-desktop.png` and `output/playwright/restricted-refresh-complete-mobile.png`.
- The refreshed PostgreSQL 16 Worker image produced a 2,050,245-byte atomic custom dump (`sha256:4f74d45ca160df29ebd36236c8e904cb9e875d4f4819198384eee5b309b24ad4`, mode `0600`) and restored it into an isolated database with 8 migrations, 11 sources, 148 Canonical Jobs, and 4 refresh audits. A deliberate incompatible-client failure preserved the previous target SHA and left zero temporary files.
