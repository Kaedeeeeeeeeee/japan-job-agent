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
