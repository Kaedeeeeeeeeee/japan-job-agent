# Japan Job Agent

日本の企業公式サイトと ATS を検証し、応募可能な求人を証拠付きで推薦する個人向け Job Agent です。

`main` の初回コミットは、実装前に確定した v0.1 仕様の読み取り専用スナップショットです。v0.2 以降の変更は Pull Request を通して追加します。

## v0.1 snapshot

- [Development specification](./japan-job-agent-spec-v0.1/japan-job-agent-development-spec-v0.1.md)
- [Database schema](./japan-job-agent-spec-v0.1/schema-v0.1.sql)
- [TypeScript contracts](./japan-job-agent-spec-v0.1/types-v0.1.ts)

## v0.2 development

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm test
```

PostgreSQL 16 + pgvector の空データベースを検証する場合：

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/japan_job_agent pnpm db:verify
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/japan_job_agent pnpm test
```

- [v0.2 delta specification](./docs/spec/v0.2-foundation-delta.md)
- [Architecture decisions](./docs/adr/README.md)

## Verified Greenhouse vertical slice

```bash
# Verify official career-site links and current Japan jobs.
pnpm live:audit

# Persist the three verified tenant/company relationships after a fresh audit.
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/japan_job_agent pnpm source:seed-verified

# Fetch exact record responses and store immutable raw objects.
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/japan_job_agent pnpm sync:greenhouse -- paypay paypaycard paypaysec
```

Without S3 variables, raw objects are private local files under `.data/`. With `S3_BUCKET` and optional `S3_ENDPOINT`, the same command uses S3-compatible private storage. Source health and sync audits are available at `/admin/sources`, `/admin/sync-runs/:id`, and the minimal `/admin/review` page.

## Deterministic extraction and schema.org

```bash
# Audits kubell and NEWONE official links and JobPosting JSON-LD.
pnpm live:audit:schema

# Persists both single records and immediately creates evidence-backed Extractions.
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/japan_job_agent pnpm sync:schema

# Replays the current parser over every pending Raw Version from a verified relationship.
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/japan_job_agent pnpm extract:pending
```

The deterministic parser records `known`, `unknown`, and `conflicting` independently. A non-unknown employment, visa, location, language, skill, or compensation fact cannot be persisted without an Evidence row. schema.org fetches are HTTPS-only, revalidate each redirect target, block private/reserved addresses, and cap responses at 5 MB.

## Canonical jobs and private Profile

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/japan_job_agent pnpm canonical:materialize
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/japan_job_agent \
  RESUME_PATH=/absolute/path/to/resume_ja.html pnpm profile:import-safe
```

Canonical merge rules are limited to normalized application URL, same-company posting/requisition identity, or a reviewed official-link Evidence. Title equality is never a merge rule, and `CanonicalService.unmerge()` preserves history and repairs both primary sources.

The resume importer uses an allowlist: it derives normalized skill and experience signals, then combines them with `config/profile-policy.json`. It never copies resume text, names, email, phone, postal address, or URLs into the Profile. The original resume is not stored or uploaded. Deterministic match results are served from `/agent/jobs` with matched, gap, unknown, hard-reject reasons, and current Canonical Evidence IDs.

## Ranking, private Web UI, and workflow state

The deterministic ranking is fixed at 100 points: role 25, skills 25, language 15, recruitment channel 10, location/remote 10, employment 5, compensation 5, and freshness/source 5. Visa and unknown salary remain informational. Experience-year requirements are evidence-backed gaps, not hard filters.

```bash
# API and authenticated Web UI
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/japan_job_agent PORT=3001 pnpm dev:api
AUTH_BYPASS_LOCAL=true API_BASE_URL=http://127.0.0.1:3001 pnpm dev:web

# Production build
pnpm build:web
```

Production ignores `AUTH_BYPASS_LOCAL`; GitHub OAuth must resolve to `Kaedeeeeeeeeee`. Saved, hidden, and applied states are persisted through `/agent/jobs/:id/state`. Recommendations, score breakdowns, explanations, and the Canonical Version/Evidence inputs are versioned in PostgreSQL.

The API also requires a server-only `API_INTERNAL_TOKEN` in production; only `/health` remains unauthenticated. A saved or applied job whose official confirmation is older than its 12/24-hour source interval can request a restricted refresh from the detail view. The request is audited, deduplicated per source and hour, executed by Temporal, and uses `source_job_records.last_seen_at` rather than creating a Raw Version when the official content is unchanged.

## Temporal and operations

```bash
DATABASE_URL=... TEMPORAL_ADDRESS=127.0.0.1:7233 pnpm worker:start
DATABASE_URL=... TEMPORAL_ADDRESS=127.0.0.1:7233 pnpm temporal:schedules
DATABASE_URL=... TEMPORAL_ADDRESS=127.0.0.1:7233 pnpm temporal:refresh-source paypay

DATABASE_URL=... pnpm backup:database
RESTORE_DATABASE_URL=... BACKUP_INPUT_PATH=... pnpm backup:restore-verify
DATABASE_URL=... pnpm acceptance:verify
pnpm deploy:preflight -- web
```

Greenhouse schedules run every 12 hours; schema.org records every 24 hours. Activity retries use persisted execution leases and the ingestion/extraction/materialization uniqueness contracts. Production preflight validates one of `api`, `web`, `worker`, `backup`, or `temporal` without printing values. The default private deployment is the [Linux + Tailscale runbook](./deploy/linux/README.md): PostgreSQL and raw objects stay on local disk, while GitHub Actions reaches only the readiness endpoint through an ephemeral tagged Tailscale identity. The [Railway deployment runbook](./deploy/railway/README.md) remains available as an alternative; see also the [Week 4 acceptance evidence](./docs/delivery/week4-ranking-ui-cloud.md).

## Company seed audit

`config/company-seeds.json` tracks all 16 requested companies. `pnpm source:seed-company-audits` persists verified official relationships and discovery states. Manual sources prove only the official company/recruiting relationship: they do not fabricate job records, enter recommendations, or participate in collection-missing closure.

## 10,000-job source expansion

The 10,000-job corpus was a source-expansion milestone, not a permanent inventory target. The current [freshness-first policy](./docs/spec/v0.3-freshness-first.md) searches new postings daily and retains full job content only when an explicit publication date is within six calendar months. Unknown dates remain invisible for a seven-day enrichment quarantine; observation time and source update time are never presented as publication time.

```bash
# Read-only impact report, then bounded/idempotent enforcement.
DATABASE_URL=... pnpm freshness:dry-run
DATABASE_URL=... RAW_STORAGE_PATH=.data pnpm freshness:apply
```

For a bounded catch-up, set an explicit publication lookback. This mode admits only jobs with a trustworthy
publication date inside the window; unknown dates, future dates, and older jobs are reported but not written.

```bash
DATABASE_URL=... DISCOVERY_BACKFILL_DAYS=30 pnpm discovery:sitemaps
DATABASE_URL=... DISCOVERY_BACKFILL_DAYS=30 pnpm discovery:public-ats
DATABASE_URL=... DISCOVERY_BACKFILL_DAYS=30 pnpm discovery:wantedly
```

Discovery directories remain isolated from recommendation-eligible jobs. JETRO OFP entries create auditable company candidates and company-level foreign-talent signals; they cannot create job records or be promoted to job-level visa facts.

Wantedly is metadata-only Discovery. Each run rechecks `robots.txt` and stops if the curated JETRO-linked
`/companies/{tenant}/projects` path is no longer allowed. It stores only stable project IDs, titles, locations,
exact `published_at` values, and public URLs; it does not log in, collect member/candidate data, store full
descriptions, train AI, or formalize Wantedly content for recommendations without a separate policy review.

```bash
DATABASE_URL=... pnpm discovery:jetro-ofp
pnpm discovery:audit-details
pnpm discovery:audit-entrypoints
pnpm discovery:audit-candidates
DATABASE_URL=... pnpm discovery:promote
DATABASE_URL=... pnpm discovery:report
DATABASE_URL=... pnpm corpus:report
DATABASE_URL=... pnpm sync:hrmos -- verified-tenant-key
```

HRMOS, HERP, Jobcan, AirWork, engage, Talentio, and Workday are complete-collection connectors: they fetch every relevant detail body before the Orchestrator may finalize an authoritative snapshot. Workday discovery uses the public CXS careers endpoint with a Japan query, then reads each Japan detail record for the exact `startDate`; relative labels such as “Posted 30+ Days Ago” are never used as publication dates. JETRO candidates pass through bounded detail, entrypoint, and job-link audits before promotion. Every company receives a terminal audit state; unsupported or unstructured pages never fabricate jobs. Global Greenhouse boards retain complete snapshots while explicit overseas locations are deterministically excluded from recommendations. IT, e-commerce, IT consulting, and HR operations are prioritized in the discovery queue while all lawful sectors, including Specified Skilled Worker routes, remain in scope. See the [source expansion design](./docs/plans/2026-07-13-source-expansion-design.md), [JETRO promotion report](./docs/delivery/jetro-ofp-promotion-2026-07-14.md), and [expanded corpus report](./docs/delivery/job-corpus-expansion-2026-07-14.md).
