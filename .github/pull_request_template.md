## What changed

- upgrades the immutable v0.1 baseline to the reviewed v0.2 foundation
- adds executable PostgreSQL, TypeScript, domain, and idempotency contracts
- adds empty-database and behavior tests for the data-chain safety invariants

## Why

The v0.1 design allowed page-level authority, mixed raw and parsed versions, ambiguous multi-value facts, coupled tenants and companies, unsafe mass closure, and duplicate workflow/event side effects. The v0.2 foundation makes these boundaries executable before live ingestion begins.

## Impact

This is the database and public-contract baseline for the Greenhouse, schema.org, parser/evidence, canonicalization, Profile, ranking, and UI vertical slices. There is no production data migration because the project has no production database yet.

## Validation

- `pnpm typecheck`
- empty `pgvector/pgvector:pg16` database: `pnpm db:verify`
- PostgreSQL-backed suite: `17/17` tests passing locally

