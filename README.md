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

Greenhouse schedules run every 12 hours; schema.org records every 24 hours. Activity retries use persisted execution leases and the ingestion/extraction/materialization uniqueness contracts. Production preflight validates one of `api`, `web`, `worker`, `backup`, or `temporal` without printing values. See the [Railway deployment runbook](./deploy/railway/README.md) and [Week 4 acceptance evidence](./docs/delivery/week4-ranking-ui-cloud.md).

## Company seed audit

`config/company-seeds.json` tracks all 16 requested companies. `pnpm source:seed-company-audits` persists verified official relationships and discovery states. Manual sources prove only the official company/recruiting relationship: they do not fabricate job records, enter recommendations, or participate in collection-missing closure.

## 10,000-job source expansion

Discovery directories are isolated from recommendation-eligible jobs. JETRO OFP entries create auditable company candidates and company-level foreign-talent signals; they cannot create job records or be promoted to job-level visa facts.

```bash
DATABASE_URL=... pnpm discovery:jetro-ofp
DATABASE_URL=... pnpm sync:hrmos -- verified-tenant-key
```

HRMOS is a complete-collection connector: it fetches every detail body before the Orchestrator may finalize an authoritative snapshot. IT, e-commerce, IT consulting, and HR operations are prioritized in the discovery queue while all lawful sectors, including Specified Skilled Worker routes, remain in scope. See the [source expansion design](./docs/plans/2026-07-13-source-expansion-design.md).
