# Source expansion rollout

This runbook lowers Engage's valid-candidate share without deleting Engage and raises strictly trusted active jobs. All production mutations are ordered and idempotent.

## Fixed acceptance thresholds

- `engageValidShare < 0.50`
- `nonEngageValid >= 19,216`
- `activeTrustedJobs >= 5,000`
- zero visible jobs older than six months or published in the future
- zero duplicate normalized application URLs, Canonical shells, unverified visible jobs, or current-parser gaps
- the complete acceptance result must pass on two consecutive Asia/Tokyo calendar days

## Rollout order

1. Keep `ENGAGE_DISCOVERY_MODE=active` and `SOURCE_EXPANSION_ENABLED=false` while deploying the migration and code.
2. Create and verify a PostgreSQL logical backup. Record its size and SHA-256 outside the database.
3. Run `pnpm db:migrate`, restart the worker only after migration succeeds, and verify API, PostgreSQL, Temporal, and worker health.
4. Download the weekly `source-tenant-candidates-*` GitHub Actions artifact. Treat the JSON as untrusted input.
5. Run `pnpm source:import-tenants <artifact> --dry-run`. Review counts by ATS, official-referrer count, JPX/JETRO ranking signals, and the expected request volume. Then repeat with `--apply`.
6. Run `pnpm source:clean-quality-debt --dry-run`. Back up again before `--apply`; that mode hides unverified formal jobs, resynchronizes parser gaps, quarantines unrecoverable records, and deletes audited Canonical shells.
7. Set `ENGAGE_DISCOVERY_MODE=pause_new` and `SOURCE_EXPANSION_ENABLED=true` in the private Linux environment. Restarting the long-lived worker is not required for oneshot discovery commands, but recreate it when the deployed image changed.
8. Run `pnpm source:scan-tenants --backfill-days 30 --batch 400`. After each batch run freshness dry-run, acceptance, and a database backup. A partial or abnormal empty snapshot never closes historical jobs or enters promotion.
9. Run `pnpm source:promote-ranked --target 5500`, `pnpm temporal:schedules`, then `pnpm freshness:apply`. Promotion requires a live exact backlink from the allowed official corporate URL to the ATS tenant.
10. Continue 400-tenant batches. `--backfill-days auto` remains at 30 days until the queue is exhausted and two successful 30-day scan runs each add less than 1%; only already verified sources can then receive a 183-day scan.
11. Run `SOURCE_EXPANSION_REQUIRE_RUNTIME_HEALTH=true pnpm acceptance:source-expansion` on two consecutive days. Do not declare completion after the first passing cycle.

## Failure behavior

- Import is idempotent on `source_kind + tenant_key`.
- A tenant claim uses `FOR UPDATE SKIP LOCKED`; its lease covers the full four-hour batch.
- A tenant receives at most three fetch attempts per batch. Persistent failures become Discovery-only after three failed runs; verified identity evidence is never discarded by a scan failure.
- Promotion failure stops later promotion for that tenant but keeps previously verified, idempotent results.
- JPX/JETRO/repository signals only affect ranking and the set of permitted corporate URLs. They cannot by themselves verify a source or make a job visible.
