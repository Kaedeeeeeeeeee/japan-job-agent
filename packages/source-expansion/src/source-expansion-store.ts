import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { OutboxDatabase } from "../../db/src/outbox.js";
import type { ExpansionSourceKind, TenantCandidateArtifact } from "./tenant-artifact.js";

export interface SourceExpansionMetrics {
  validJobs: number;
  engageValid: number;
  nonEngageValid: number;
  engageValidShare: number;
  activeTrustedJobs: number;
}

export interface TenantImportReport {
  artifactCandidates: number;
  wouldInsert: number;
  wouldUpdate: number;
  inserted: number;
  updated: number;
  japanSignals: number;
  officialReferrers: number;
  estimatedMinimumRequests: number;
  estimatedMaximumRequests: number;
  byKind: Record<string, number>;
}

export interface ClaimedTenant {
  id: string;
  sourceKind: ExpansionSourceKind;
  tenantKey: string;
  companyName: string | null;
  sourceUrl: string;
  officialReferrerUrl: string | null;
  japanSignal: boolean;
}

export class SourceExpansionStore {
  constructor(private readonly db: Kysely<OutboxDatabase>) {}

  async metrics(): Promise<SourceExpansionMetrics> {
    const result = await sql<{ valid_jobs: number; engage_valid: number; non_engage_valid: number;
      active_trusted_jobs: number }>`WITH valid_candidates AS (
        SELECT * FROM job_discovery_candidates WHERE location_state='japan' AND state NOT IN ('rejected','expired')
          AND publication_freshness='recent' AND content_purged_at IS NULL
          AND ((origin_kind='official_collection' AND last_authoritative_import_run_id IS NOT NULL
              AND last_authoritative_seen_at>=now()-interval '72 hours')
            OR (origin_kind<>'official_collection' AND observation_count>=2
              AND last_seen_at>=now()-interval '30 days'))
      ), trusted AS (
        SELECT count(DISTINCT job.id)::int count FROM canonical_jobs job
        JOIN canonical_job_sources link ON link.canonical_job_id=job.id AND link.active_to IS NULL
        JOIN source_job_records record ON record.id=link.source_job_record_id AND record.lifecycle_state='active'
        JOIN source_instances source ON source.id=record.source_instance_id AND source.verification_state='verified'
        JOIN company_source_relationships relationship ON relationship.source_instance_id=source.id
          AND relationship.verification_state='verified' AND relationship.valid_to IS NULL
        JOIN evidence ON evidence.company_source_relationship_id=relationship.id
        WHERE job.lifecycle_state='active' AND job.current_version_id IS NOT NULL
      ) SELECT count(*)::int valid_jobs,
        count(*) FILTER (WHERE source_family='engage')::int engage_valid,
        count(*) FILTER (WHERE source_family<>'engage')::int non_engage_valid,
        (SELECT count FROM trusted)::int active_trusted_jobs FROM valid_candidates`.execute(this.db);
    const row = result.rows[0] ?? { valid_jobs: 0, engage_valid: 0, non_engage_valid: 0, active_trusted_jobs: 0 };
    return {
      validJobs: row.valid_jobs,
      engageValid: row.engage_valid,
      nonEngageValid: row.non_engage_valid,
      engageValidShare: row.valid_jobs === 0 ? 0 : row.engage_valid / row.valid_jobs,
      activeTrustedJobs: row.active_trusted_jobs,
    };
  }

  async beginRun(runKind: "import" | "scan" | "promote" | "quality_cleanup" | "acceptance",
    options: { backfillDays?: number; requestedBatch?: number } = {}): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO source_expansion_runs(id,run_kind,backfill_days,requested_batch,baseline_metrics)
      VALUES (${id}::uuid,${runKind},${options.backfillDays ?? null},${options.requestedBatch ?? null},
        ${JSON.stringify(await this.metrics())}::jsonb)`.execute(this.db);
    return id;
  }

  async finishRun(runId: string, status: "succeeded" | "failed", counters: Record<string, unknown>,
    errors: unknown[] = []): Promise<void> {
    await sql`UPDATE source_expansion_runs SET status=${status}::sync_status,final_metrics=${JSON.stringify(await this.metrics())}::jsonb,
      counters=${JSON.stringify(counters)}::jsonb,error_summary=${JSON.stringify(errors)}::jsonb,finished_at=now()
      WHERE id=${runId}::uuid AND status='running'`.execute(this.db);
  }

  async importArtifact(artifact: TenantCandidateArtifact, apply: boolean): Promise<TenantImportReport> {
    const keys = artifact.candidates.map((candidate) => `${candidate.sourceKind}:${candidate.tenantKey.toLowerCase()}`);
    const existing = keys.length === 0 ? new Set<string>() : new Set((await sql<{ key: string }>`SELECT
        source_kind::text || ':' || lower(tenant_key) key FROM source_tenant_candidates
      WHERE source_kind::text || ':' || lower(tenant_key) IN (${sql.join(keys.map((key) => sql`${key}`))})`.execute(this.db)).rows
      .map((row) => row.key));
    const report: TenantImportReport = {
      artifactCandidates: artifact.candidates.length,
      wouldInsert: keys.filter((key) => !existing.has(key)).length,
      wouldUpdate: keys.filter((key) => existing.has(key)).length,
      inserted: 0,
      updated: 0,
      japanSignals: artifact.candidates.filter((candidate) => candidate.japanSignalBasis !== undefined).length,
      officialReferrers: artifact.candidates.filter((candidate) => candidate.officialReferrerUrl !== undefined).length,
      estimatedMinimumRequests: artifact.candidates.length,
      estimatedMaximumRequests: artifact.candidates.length * 120,
      byKind: Object.fromEntries([...Map.groupBy(artifact.candidates, (candidate) => candidate.sourceKind)]
        .map(([kind, values]) => [kind, values.length])),
    };
    if (!apply) return report;
    for (const candidate of artifact.candidates) {
      const locator = {
        artifactGeneratedAt: artifact.generatedAt,
        artifactGenerator: artifact.generator,
        repositoryUrl: candidate.repositoryUrl ?? null,
        repositoryHomepage: candidate.repositoryHomepage ?? null,
        repositoryCname: candidate.repositoryCname ?? null,
        japanSignalBasis: candidate.japanSignalBasis ?? null,
        japanSignalCompanyName: candidate.japanSignalCompanyName ?? null,
        evidence: candidate.evidence,
      };
      const result = await sql<{ inserted: boolean }>`INSERT INTO source_tenant_candidates(
          source_kind,tenant_key,company_name,source_url,discovery_basis,discovery_locator,japan_signal,
          official_referrer_url,official_referrer_basis,review_state,last_seen_at
        ) VALUES (${candidate.sourceKind}::source_kind,${candidate.tenantKey},${candidate.companyName ?? null},
          ${candidate.sourceUrl},${candidate.discoveredVia},${JSON.stringify(locator)}::jsonb,
          ${candidate.japanSignalBasis !== undefined},${candidate.officialReferrerUrl ?? null},
          ${candidate.officialReferrerBasis ?? null},'discovered',now())
        ON CONFLICT(source_kind,(lower(tenant_key))) DO UPDATE SET
          company_name=COALESCE(source_tenant_candidates.company_name,excluded.company_name),
          source_url=excluded.source_url,last_seen_at=now(),
          discovery_locator=source_tenant_candidates.discovery_locator || excluded.discovery_locator,
          japan_signal=source_tenant_candidates.japan_signal OR excluded.japan_signal,
          official_referrer_url=COALESCE(source_tenant_candidates.official_referrer_url,excluded.official_referrer_url),
          official_referrer_basis=COALESCE(source_tenant_candidates.official_referrer_basis,excluded.official_referrer_basis),
          updated_at=now()
        RETURNING (xmax=0) inserted`.execute(this.db);
      if (result.rows[0]?.inserted === true) report.inserted += 1; else report.updated += 1;
    }
    await this.applyJetroSignals();
    return report;
  }

  async claimTenants(workerId: string, limit: number, leaseMilliseconds: number, backfillDays: number): Promise<ClaimedTenant[]> {
    return this.db.transaction().execute(async (trx) => {
      const result = await sql<{ id: string; source_kind: ExpansionSourceKind; tenant_key: string;
        company_name: string | null; source_url: string; official_referrer_url: string | null; japan_signal: boolean }>`WITH selected AS (
          SELECT id FROM source_tenant_candidates
          WHERE ((${backfillDays}<183 AND review_state IN ('discovered','eligible','scanned','verification_pending','retryable_failure'))
              OR (${backfillDays}>=183 AND review_state='verified' AND COALESCE(scan_backfill_days,0)<183))
            AND next_scan_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<now())
          ORDER BY japan_signal DESC,japan_recent_job_count DESC,latest_published_on DESC NULLS LAST,
            last_scanned_at NULLS FIRST,id
          LIMIT ${limit} FOR UPDATE SKIP LOCKED
        ) UPDATE source_tenant_candidates candidate SET claimed_from_state=candidate.review_state,review_state='scanning',lease_owner=${workerId},
          lease_expires_at=now()+(${leaseMilliseconds}::text || ' milliseconds')::interval,updated_at=now()
        FROM selected WHERE candidate.id=selected.id
        RETURNING candidate.id,candidate.source_kind,candidate.tenant_key,candidate.company_name,
          candidate.source_url,candidate.official_referrer_url,candidate.japan_signal`.execute(trx);
      return result.rows.map((row) => ({ id: row.id, sourceKind: row.source_kind, tenantKey: row.tenant_key,
        companyName: row.company_name, sourceUrl: row.source_url, officialReferrerUrl: row.official_referrer_url,
        japanSignal: row.japan_signal }));
    });
  }

  async completeScan(input: { id: string; workerId: string; backfillDays: number; snapshotKind: "authoritative" | "partial";
    completed: boolean; japanRecentJobs: number; latestPublishedOn: string | null; explicitCompanyUrl?: string; error?: string }): Promise<void> {
    const retry = input.error !== undefined;
    await sql`UPDATE source_tenant_candidates SET
      review_state=CASE WHEN claimed_from_state='verified' THEN 'verified'
        WHEN ${retry} AND consecutive_failures+1>=3 THEN 'discovery_only'
        ELSE ${retry ? "retryable_failure" : input.completed ? "scanned" : "discovery_only"} END,
      scan_backfill_days=${input.backfillDays},last_snapshot_kind=${input.snapshotKind}::snapshot_kind,
      last_scan_completed=${input.completed},japan_recent_job_count=${input.japanRecentJobs},
      latest_published_on=${input.latestPublishedOn}::date,last_scanned_at=now(),
      official_referrer_url=COALESCE(official_referrer_url,${input.explicitCompanyUrl ?? null}),
      official_referrer_basis=COALESCE(official_referrer_basis,
        CASE WHEN ${input.explicitCompanyUrl ?? null}::text IS NULL THEN NULL ELSE 'ats_company_url' END),
      japan_signal=japan_signal OR ${input.japanRecentJobs > 0},
      consecutive_failures=CASE WHEN ${retry} THEN consecutive_failures+1 ELSE 0 END,
      failure_reason=${input.error ?? null},next_scan_at=CASE WHEN ${retry}
        THEN now()+make_interval(hours=>LEAST(24,power(2,LEAST(consecutive_failures,4))::int)) ELSE now()+interval '24 hours' END,
      lease_owner=NULL,lease_expires_at=NULL,claimed_from_state=NULL,updated_at=now()
      WHERE id=${input.id}::uuid AND lease_owner=${input.workerId}`.execute(this.db);
  }

  async releaseLease(id: string, workerId: string, error: string): Promise<void> {
    await sql`UPDATE source_tenant_candidates SET review_state=CASE WHEN claimed_from_state='verified' THEN 'verified'
        WHEN consecutive_failures+1>=3 THEN 'discovery_only' ELSE 'retryable_failure' END,failure_reason=${error.slice(0, 1_000)},
      consecutive_failures=consecutive_failures+1,next_scan_at=now()+make_interval(
        hours=>LEAST(24,power(2,LEAST(consecutive_failures,4))::int)),
      lease_owner=NULL,lease_expires_at=NULL,claimed_from_state=NULL,updated_at=now() WHERE id=${id}::uuid AND lease_owner=${workerId}`.execute(this.db);
  }

  async recommendedBackfillDays(): Promise<30 | 183> {
    const metrics = await this.metrics();
    if (metrics.activeTrustedJobs >= 5_000) return 30;
    const state = await sql<{ remaining: number; verified_for_backfill: number; low_growth_runs: number }>`SELECT
      (SELECT count(*)::int FROM source_tenant_candidates WHERE review_state IN
        ('discovered','eligible','scanning','verification_pending','retryable_failure')) remaining,
      (SELECT count(*)::int FROM source_tenant_candidates WHERE review_state='verified'
        AND COALESCE(scan_backfill_days,0)<183) verified_for_backfill,
      (SELECT count(*)::int FROM (SELECT COALESCE((counters->>'candidateGrowthRatio')::numeric,1) ratio
        FROM source_expansion_runs WHERE run_kind='scan' AND status='succeeded' AND backfill_days=30
        ORDER BY started_at DESC LIMIT 2) recent WHERE ratio<0.01) low_growth_runs`.execute(this.db);
    const row = state.rows[0];
    return row !== undefined && row.remaining === 0 && row.verified_for_backfill > 0 && row.low_growth_runs >= 2 ? 183 : 30;
  }

  private async applyJetroSignals(): Promise<void> {
    await sql`UPDATE source_tenant_candidates tenant SET japan_signal=true,
        discovery_locator=tenant.discovery_locator || jsonb_build_object('jetroNameMatch',candidate.display_name),updated_at=now()
      FROM company_discovery_candidates candidate JOIN discovery_sources source ON source.id=candidate.discovery_source_id
      WHERE source.source_key='jetro-ofp' AND tenant.company_name IS NOT NULL
        AND lower(regexp_replace(tenant.company_name,'[^[:alnum:]]','','g'))=
          lower(regexp_replace(candidate.display_name,'[^[:alnum:]]','','g'))`.execute(this.db);
    await sql`UPDATE source_tenant_candidates tenant SET
        official_referrer_url=COALESCE(tenant.official_referrer_url,source_candidate.official_referrer_url),
        official_referrer_basis=COALESCE(tenant.official_referrer_basis,'jetro'),updated_at=now()
      FROM source_discovery_candidates source_candidate
      JOIN company_discovery_candidates company ON company.id=source_candidate.company_discovery_candidate_id
      JOIN discovery_sources source ON source.id=company.discovery_source_id
      WHERE source.source_key='jetro-ofp' AND source_candidate.source_kind=tenant.source_kind
        AND source_candidate.tenant_key=tenant.tenant_key AND source_candidate.official_referrer_url IS NOT NULL`.execute(this.db);
  }
}
