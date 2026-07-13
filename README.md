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
