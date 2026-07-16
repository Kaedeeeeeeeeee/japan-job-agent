# 10,000 Discovery expansion — final acceptance (2026-07-15)

The expansion target is complete on the local PostgreSQL 16 + pgvector database.

## Accepted data state

- Discovery candidates: 10,576 total; 10,219 satisfy the strict counting rules.
- Verified active Canonical Jobs: 2,056.
- Largest Discovery source-family share: 32.29% (below the 40% ceiling).
- Strong duplicate groups: external ID 0, detail URL 0, official URL 0.
- Active Canonical Jobs without a verified official source: 0.
- Active Canonical Jobs without an official application URL: 0.
- Non-unknown high-risk facts: 4,483; missing Evidence: 0.
- Non-unknown date facts: 1,938; missing Evidence: 0.
- Erroneous closures caused by partial or failed synchronization: 0.
- Current deterministic Parser: 1.8.3 / job-v3; successful Raw replays: 2,072.

The effective Discovery families are engage, Talentio, YOLO JAPAN, SmartRecruiters, HRMOS, Greenhouse, AirWork, Ashby, Lever, HERP, and Jobcan. Formal jobs are currently supplied by nine verified source kinds. Bosch SmartRecruiters promotion consumes every provider page but admits only the Japan-classified external IDs into the authoritative formal snapshot.

## Runtime acceptance

- `/agent/jobs`, 20 measured requests against 2,056 active jobs: p50 454.8 ms; p95 465.6 ms.
- Required ceiling: p95 500 ms.
- `/health/ready` performs a real `SELECT 1` and returns ready only after database access succeeds.
- Empty-database verification: all 14 migrations applied successfully.
- Automated tests: 43 files, 182 tests passed.
- TypeScript lint/typecheck, Next.js production build, Linux Compose rendering, GitHub Actions YAML parsing, and `git diff --check` passed.

## Recovery drill

- Backup: `.data/backups/discovery-final-2026-07-15.dump`
- Format/permissions: PostgreSQL custom dump, mode `0600`, 169 MB.
- SHA-256: `7563583d23eaecf6e9fac409cae00d5a8be5c5a99ef4350404f34693982178b2`
- Restored into a new empty database and rechecked: 14 migrations, 10,576 candidates, 2,056 active Canonical Jobs, and 2,072 Raw Versions.
- The complete Discovery acceptance suite passed against the restored database before the temporary restore database was removed.

Generated source and formal-corpus audits are stored in `config/discovery-corpus-audit-2026-07-15.json`, `config/job-corpus-audit-2026-07-15.json`, and the corresponding delivery reports.
