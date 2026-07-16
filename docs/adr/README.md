# Architecture Decision Records

| ADR | Decision | Status |
|---|---|---|
| [001](./001-company-is-legal-entity.md) | Company is a legal entity | Accepted v0.2 |
| [002](./002-immutable-raw-versions.md) | Raw versions are immutable | Superseded in detail by ADR-014 |
| [003](./003-canonical-not-headcount.md) | Canonical Job is not headcount | Accepted v0.2 |
| [004](./004-postgres-system-of-record.md) | PostgreSQL is the system of record | Accepted v0.2 |
| [005](./005-source-state-not-majority-vote.md) | Source state is not majority voting | Accepted v0.2 |
| [006](./006-explicit-unknown-conflicting.md) | Unknown/conflicting are first-class | Accepted v0.2 |
| [007](./007-evidence-only-explanations.md) | Explanations require evidence | Accepted v0.2 |
| [008](./008-snapshot-semantics.md) | Snapshot authority belongs to orchestrator | Superseded by ADR-016 |
| [009](./009-temporal-workflows.md) | Temporal coordinates durable workflows | Accepted with ADR-018 |
| [010](./010-search-foundation.md) | Structured search before embeddings | Accepted v0.2 |
| [011](./011-untrusted-web-input.md) | Web content is untrusted | Accepted v0.2 |
| [012](./012-versioned-recommendations.md) | Recommendations are reproducible | Accepted v0.2 |
| [013](./013-source-company-decoupling.md) | Source Instance and Company are decoupled | Accepted |
| [014](./014-raw-extraction-separation.md) | Raw and Extraction versions are separate | Accepted |
| [015](./015-primary-source-truth.md) | Canonical source table is sole primary truth | Accepted |
| [016](./016-orchestrator-finalized-snapshot.md) | Orchestrator finalizes snapshots | Accepted |
| [017](./017-closure-circuit-breaker.md) | Closing requires interval and circuit safety | Accepted |
| [018](./018-temporal-outbox-idempotency.md) | Temporal and Outbox are idempotent | Accepted |
| [019](./019-llm-evidence-and-embedding-recall.md) | LLM proposes evidence; embeddings recall only | Accepted |
| [020](./020-job-discovery-isolation-and-promotion.md) | Discovery is isolated until verified promotion | Accepted |
