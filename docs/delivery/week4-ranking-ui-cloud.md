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
