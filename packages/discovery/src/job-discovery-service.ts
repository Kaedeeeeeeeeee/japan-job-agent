import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type {
  CandidateResolution,
  JobDiscoveryLead,
  JobDiscoveryLocationState,
  JobPromotionAttempt,
} from "../../contracts/src/index.js";
import { jobDiscoveryLeadSchema } from "../../contracts/src/index.js";
import { normalizeApplicationUrl } from "../../canonical/src/normalize-application-url.js";
import type { OutboxDatabase } from "../../db/src/outbox.js";

interface CandidateRow {
  id: string;
  state: "discovered" | "resolving" | "resolved" | "promoted" | "rejected" | "expired";
  origin_kind: JobDiscoveryLead["originKind"];
  source_family: string;
  source_kind_hint: JobDiscoveryLead["sourceKindHint"] | null;
  tenant_key: string | null;
  external_posting_id: string | null;
  external_key: string;
  detail_url: string;
  normalized_detail_url: string;
  official_url: string | null;
  normalized_official_url: string | null;
  company_name: string;
  normalized_company_name: string;
  title: string;
  location_text: string;
  location_state: JobDiscoveryLocationState;
  priority: JobDiscoveryLead["priority"];
  observation_count: number;
  first_seen_at: Date;
  last_seen_at: Date;
  last_authoritative_seen_at: Date | null;
  last_authoritative_import_run_id: string | null;
  resolved_source_instance_id: string | null;
  promoted_source_job_record_id: string | null;
  rejection_reason: string | null;
}

interface PromotionRow {
  id: string;
  candidate_id: string;
  idempotency_key: string;
  state: JobPromotionAttempt["state"];
  available_at: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  attempt_count: number;
  failure_stage: string | null;
  last_error: string | null;
}

export interface IngestJobLeadResult {
  candidateId: string;
  candidateCreated: boolean;
  observationCreated: boolean;
  countable: boolean;
}

export interface FinalizedAuthoritativeImportInput {
  discoverySourceId: string;
  idempotencyKey: string;
  pageCount: number;
  providerTotal: number | null;
  discoveredCount: number;
  rawHash: string;
  validation: {
    allPagesCompleted: boolean;
    tenantIdentityConsistent: boolean;
    providerTotalMatched: boolean;
    parseErrors: string[];
  };
}

export interface DiscoverySummary {
  total: number;
  valid: number;
  discovered: number;
  resolving: number;
  resolved: number;
  promoted: number;
  rejected: number;
  expired: number;
  japan: number;
  nonJapan: number;
  unknownLocation: number;
  publishedKnown: number;
}

export class JobDiscoveryService {
  constructor(private readonly db: Kysely<OutboxDatabase>) {}

  async recordFinalizedAuthoritativeImport(input: FinalizedAuthoritativeImportInput): Promise<string> {
    if (!Number.isInteger(input.pageCount) || input.pageCount < 1) throw new Error("Authoritative import requires every page");
    if (!Number.isInteger(input.discoveredCount) || input.discoveredCount < 0) throw new Error("Invalid discovered count");
    if (!/^[0-9a-f]{64}$/.test(input.rawHash)) throw new Error("Authoritative import raw hash must be SHA-256");
    if (!input.validation.allPagesCompleted || !input.validation.tenantIdentityConsistent
      || !input.validation.providerTotalMatched || input.validation.parseErrors.length > 0) {
      throw new Error("Partial or invalid collection cannot become an authoritative Discovery import");
    }
    const validation = { snapshotKind: "authoritative", ...input.validation };
    const result = await sql<{ id: string }>`INSERT INTO discovery_import_runs(
        discovery_source_id,idempotency_key,status,page_count,provider_total,discovered_count,raw_hash,
        validation_result,finished_at
      ) VALUES (${input.discoverySourceId}::uuid,${input.idempotencyKey},'succeeded',${input.pageCount},
        ${input.providerTotal},${input.discoveredCount},${input.rawHash},${JSON.stringify(validation)}::jsonb,now())
      ON CONFLICT(discovery_source_id,idempotency_key) DO UPDATE SET
        status='succeeded',page_count=excluded.page_count,provider_total=excluded.provider_total,
        discovered_count=excluded.discovered_count,raw_hash=excluded.raw_hash,
        validation_result=excluded.validation_result,finished_at=now(),error_detail=NULL
      RETURNING id`.execute(this.db);
    return result.rows[0]!.id;
  }

  async ingest(input: JobDiscoveryLead): Promise<IngestJobLeadResult> {
    const lead = jobDiscoveryLeadSchema.parse(input);
    const normalizedDetailUrl = normalizeApplicationUrl(lead.detailUrl);
    const normalizedOfficialUrl = lead.officialUrl === undefined ? null : normalizeApplicationUrl(lead.officialUrl);
    const normalizedCompanyName = normalizeCompanyName(lead.companyName);
    const locationState = classifyJapanLocation(lead.locationText);
    const observedAt = new Date(lead.observedAt);
    const lockKey = strongKey(lead, normalizedDetailUrl, normalizedOfficialUrl);

    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(trx);
      const authoritativeRunId = lead.authoritative
        ? await validatedAuthoritativeRun(trx, lead.discoveryImportRunId, lead.discoverySourceId)
        : null;
      const existing = await sql<CandidateRow>`SELECT * FROM job_discovery_candidates
        WHERE normalized_detail_url=${normalizedDetailUrl}
          OR (${normalizedOfficialUrl}::text IS NOT NULL AND normalized_official_url=${normalizedOfficialUrl})
          OR (${lead.tenantKey ?? null}::text IS NOT NULL AND ${lead.externalPostingId ?? null}::text IS NOT NULL
            AND source_family=${lead.sourceFamily} AND tenant_key=${lead.tenantKey ?? null}
            AND external_posting_id=${lead.externalPostingId ?? null})
        ORDER BY created_at, id LIMIT 1 FOR UPDATE`.execute(trx);
      const candidateId = existing.rows[0]?.id ?? randomUUID();
      const candidateCreated = existing.rows[0] === undefined;
      if (candidateCreated) {
        await sql`INSERT INTO job_discovery_candidates(
            id,discovery_source_id,origin_kind,source_family,source_kind_hint,tenant_key,external_posting_id,
            external_key,detail_url,normalized_detail_url,official_url,normalized_official_url,
            company_name,normalized_company_name,title,location_text,location_state,priority,
            first_seen_at,last_seen_at,last_authoritative_seen_at,last_authoritative_import_run_id,
            source_published_date,source_published_at,source_published_precision
          ) VALUES (
            ${candidateId}::uuid,${lead.discoverySourceId}::uuid,${lead.originKind}::job_discovery_origin_kind,
            ${lead.sourceFamily},${lead.sourceKindHint ?? null}::source_kind,${lead.tenantKey ?? null},
            ${lead.externalPostingId ?? null},${lead.externalKey},${lead.detailUrl},${normalizedDetailUrl},
            ${lead.officialUrl ?? null},${normalizedOfficialUrl},${lead.companyName},${normalizedCompanyName},
            ${lead.title},${lead.locationText},${locationState}::job_discovery_location_state,${lead.priority}::corpus_priority,
            ${lead.observedAt}::timestamptz,${lead.observedAt}::timestamptz,
            NULL,NULL,
            ${lead.published?.precision === "date" ? lead.published.value : null}::date,
            ${lead.published?.precision === "datetime" ? lead.published.value : null}::timestamptz,
            ${lead.published?.precision ?? null}::job_date_precision
          )`.execute(trx);
      } else {
        const row = existing.rows[0]!;
        await sql`UPDATE job_discovery_candidates SET
          origin_kind=${preferOrigin(row.origin_kind, lead.originKind)}::job_discovery_origin_kind,
          source_kind_hint=COALESCE(source_kind_hint,${lead.sourceKindHint ?? null}::source_kind),
          tenant_key=COALESCE(tenant_key,${lead.tenantKey ?? null}),
          external_posting_id=COALESCE(external_posting_id,${lead.externalPostingId ?? null}),
          official_url=COALESCE(official_url,${lead.officialUrl ?? null}),
          normalized_official_url=COALESCE(normalized_official_url,${normalizedOfficialUrl}),
          company_name=CASE WHEN length(${lead.companyName})>length(company_name) THEN ${lead.companyName} ELSE company_name END,
          normalized_company_name=CASE WHEN length(${normalizedCompanyName})>length(normalized_company_name)
            THEN ${normalizedCompanyName} ELSE normalized_company_name END,
          title=CASE WHEN length(${lead.title})>length(title) THEN ${lead.title} ELSE title END,
          location_text=CASE WHEN location_state='japan' THEN location_text ELSE ${lead.locationText} END,
          location_state=CASE WHEN location_state='japan' THEN location_state ELSE ${locationState}::job_discovery_location_state END,
          priority=LEAST(priority,${lead.priority}::corpus_priority),
          source_published_date=COALESCE(source_published_date,${lead.published?.precision === "date" ? lead.published.value : null}::date),
          source_published_at=COALESCE(source_published_at,${lead.published?.precision === "datetime" ? lead.published.value : null}::timestamptz),
          source_published_precision=COALESCE(source_published_precision,${lead.published?.precision ?? null}::job_date_precision),
          updated_at=now()
          WHERE id=${candidateId}::uuid`.execute(trx);
      }

      const observationId = randomUUID();
      const observation = await sql<{ id: string }>`INSERT INTO job_discovery_observations(
          id,candidate_id,observation_key,source_url,outbound_url,raw_company_name,raw_title,
          raw_location_text,raw_published_text,payload_hash,response_metadata,observed_at,discovery_import_run_id
        ) VALUES (
          ${observationId}::uuid,${candidateId}::uuid,${lead.observationKey},${lead.detailUrl},${lead.officialUrl ?? null},
          ${lead.companyName},${lead.title},${lead.locationText},${lead.rawPublishedText ?? null},${lead.payloadHash},
          ${JSON.stringify(lead.responseMetadata)}::jsonb,${lead.observedAt}::timestamptz,${lead.discoveryImportRunId ?? null}::uuid
        ) ON CONFLICT(candidate_id,observation_key) DO NOTHING RETURNING id`.execute(trx);
      const observationCreated = observation.rows[0] !== undefined;
      if (observationCreated) {
        await sql`UPDATE job_discovery_candidates SET observation_count=observation_count+1,
          last_seen_at=GREATEST(last_seen_at,${lead.observedAt}::timestamptz),updated_at=now()
          WHERE id=${candidateId}::uuid`.execute(trx);
      }
      if (authoritativeRunId !== null) {
        const boundObservation = observation.rows[0] === undefined
          ? (await sql<{ id: string; observed_at: Date }>`SELECT id,observed_at
          FROM job_discovery_observations WHERE candidate_id=${candidateId}::uuid
            AND observation_key=${lead.observationKey} AND discovery_import_run_id=${authoritativeRunId}::uuid`.execute(trx)).rows[0]
          : { id: observation.rows[0].id, observed_at: observedAt };
        if (boundObservation === undefined) {
          throw new Error("Authoritative freshness requires an immutable observation bound to the finalized import run");
        }
        await sql`UPDATE job_discovery_candidates SET
          last_authoritative_seen_at=GREATEST(COALESCE(last_authoritative_seen_at,'-infinity'::timestamptz),
            ${boundObservation.observed_at.toISOString()}::timestamptz),
          last_authoritative_import_run_id=${authoritativeRunId}::uuid,updated_at=now()
          WHERE id=${candidateId}::uuid`.execute(trx);
      }
      const current = await this.loadCandidate(candidateId, trx);
      return { candidateId, candidateCreated, observationCreated, countable: isCountableCandidate(current, observedAt) };
    });
  }

  async observeAuthoritativePresence(input: {
    candidateId: string;
    discoveryImportRunId: string;
    observationKey: string;
    observedAt: string;
    payloadHash: string;
    responseMetadata?: Record<string, unknown>;
  }): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(input.payloadHash)) throw new Error("Snapshot presence payload hash must be SHA-256");
    return this.db.transaction().execute(async (trx) => {
      const candidate = await this.loadCandidate(input.candidateId, trx);
      await validatedAuthoritativeRun(trx, input.discoveryImportRunId,
        (await sql<{ discovery_source_id: string }>`SELECT discovery_source_id FROM job_discovery_candidates
          WHERE id=${input.candidateId}::uuid FOR UPDATE`.execute(trx)).rows[0]!.discovery_source_id);
      const observation = await sql<{ id: string }>`INSERT INTO job_discovery_observations(
          id,candidate_id,discovery_import_run_id,observation_key,source_url,outbound_url,raw_company_name,
          raw_title,raw_location_text,payload_hash,response_metadata,observed_at
        ) VALUES (${randomUUID()}::uuid,${candidate.id}::uuid,${input.discoveryImportRunId}::uuid,
          ${input.observationKey},${candidate.detail_url},${candidate.official_url},${candidate.company_name},
          ${candidate.title},${candidate.location_text},${input.payloadHash},
          ${JSON.stringify(input.responseMetadata ?? {})}::jsonb,${input.observedAt}::timestamptz)
        ON CONFLICT(candidate_id,observation_key) DO NOTHING RETURNING id`.execute(trx);
      const boundObservation = observation.rows[0] === undefined
        ? (await sql<{ id: string; observed_at: Date }>`SELECT id,observed_at
        FROM job_discovery_observations WHERE candidate_id=${candidate.id}::uuid
          AND observation_key=${input.observationKey}
          AND discovery_import_run_id=${input.discoveryImportRunId}::uuid`.execute(trx)).rows[0]
        : { id: observation.rows[0].id, observed_at: new Date(input.observedAt) };
      if (boundObservation === undefined) {
        throw new Error("Snapshot presence observation is already bound to a different import run");
      }
      await sql`UPDATE job_discovery_candidates SET
        observation_count=observation_count+${observation.rows[0] === undefined ? 0 : 1},
        last_seen_at=GREATEST(last_seen_at,${boundObservation.observed_at.toISOString()}::timestamptz),
        last_authoritative_seen_at=GREATEST(COALESCE(last_authoritative_seen_at,'-infinity'::timestamptz),
          ${boundObservation.observed_at.toISOString()}::timestamptz),
        last_authoritative_import_run_id=${input.discoveryImportRunId}::uuid,updated_at=now()
        WHERE id=${candidate.id}::uuid`.execute(trx);
      return isCountableCandidate(await this.loadCandidate(candidate.id, trx), new Date(input.observedAt));
    });
  }

  async applyResolution(candidateId: string, resolution: CandidateResolution): Promise<string> {
    if (resolution.status === "retryable") {
      await sql`UPDATE job_discovery_candidates SET state='discovered',rejection_reason=${resolution.reason},updated_at=now()
        WHERE id=${candidateId}::uuid AND state IN ('discovered','resolving')`.execute(this.db);
      return candidateId;
    }
    if (resolution.status === "rejected") {
      await sql`UPDATE job_discovery_candidates SET state='rejected',rejection_reason=${resolution.reason},updated_at=now()
        WHERE id=${candidateId}::uuid AND state<>'promoted'`.execute(this.db);
      return candidateId;
    }
    const normalizedOfficialUrl = normalizeApplicationUrl(resolution.officialUrl);
    return this.db.transaction().execute(async (trx) => {
      const verified = await sql<{ evidence_count: number }>`SELECT count(DISTINCT e.id)::int evidence_count
        FROM source_instances s
        JOIN company_source_relationships csr ON csr.source_instance_id=s.id
          AND csr.verification_state='verified' AND csr.valid_to IS NULL
        JOIN evidence e ON e.company_source_relationship_id=csr.id
        WHERE s.id=${resolution.sourceInstanceId}::uuid AND s.verification_state='verified'
          AND e.id IN (${sql.join(resolution.evidenceIds.map((id) => sql`${id}::uuid`))})`.execute(trx);
      if ((verified.rows[0]?.evidence_count ?? 0) !== resolution.evidenceIds.length) {
        throw new Error("Candidate resolution requires evidence from a verified Company-Source relationship");
      }
      const duplicate = await sql<{ id: string }>`SELECT id FROM job_discovery_candidates
        WHERE normalized_official_url=${normalizedOfficialUrl} AND id<>${candidateId}::uuid
        ORDER BY created_at,id LIMIT 1 FOR UPDATE`.execute(trx);
      const survivor = duplicate.rows[0]?.id;
      if (survivor !== undefined) {
        await sql`UPDATE job_discovery_candidates SET state='rejected',
          rejection_reason=${`strong_duplicate_of:${survivor}`},updated_at=now() WHERE id=${candidateId}::uuid`.execute(trx);
        return survivor;
      }
      await sql`UPDATE job_discovery_candidates SET state='resolved',official_url=${resolution.officialUrl},
        normalized_official_url=${normalizedOfficialUrl},resolved_source_instance_id=${resolution.sourceInstanceId}::uuid,
        rejection_reason=NULL,updated_at=now()
        WHERE id=${candidateId}::uuid AND state IN ('discovered','resolving','resolved')`.execute(trx);
      for (const evidenceId of resolution.evidenceIds) {
        await sql`INSERT INTO job_discovery_resolution_evidence(candidate_id,evidence_id)
          VALUES (${candidateId}::uuid,${evidenceId}::uuid) ON CONFLICT DO NOTHING`.execute(trx);
      }
      return candidateId;
    });
  }

  async enqueuePromotion(candidateId: string, idempotencyKey: string, availableAt = new Date()): Promise<string> {
    const attemptId = randomUUID();
    const inserted = await sql<{ id: string }>`INSERT INTO job_promotion_attempts(id,candidate_id,idempotency_key,available_at)
      SELECT ${attemptId}::uuid,id,${idempotencyKey},${availableAt.toISOString()}::timestamptz
      FROM job_discovery_candidates WHERE id=${candidateId}::uuid AND state='resolved'
      ON CONFLICT(candidate_id,idempotency_key) DO NOTHING RETURNING id`.execute(this.db);
    if (inserted.rows[0] !== undefined) return inserted.rows[0].id;
    const existing = await sql<{ id: string }>`SELECT id FROM job_promotion_attempts
      WHERE candidate_id=${candidateId}::uuid AND idempotency_key=${idempotencyKey}`.execute(this.db);
    if (existing.rows[0] === undefined) throw new Error("Only resolved candidates can be queued for promotion");
    return existing.rows[0].id;
  }

  async claimPromotionAttempts(workerId: string, limit: number, leaseMs = 5 * 60_000): Promise<JobPromotionAttempt[]> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const technologyQuota = Math.round(safeLimit * 0.5);
    const consultHrQuota = Math.round(safeLimit * 0.25);
    const otherQuota = safeLimit - technologyQuota - consultHrQuota;
    const claimed = await sql<PromotionRow>`WITH technology AS MATERIALIZED (
        SELECT a.id FROM job_promotion_attempts a
        JOIN job_discovery_candidates c ON c.id=a.candidate_id
        WHERE (
          (a.state IN ('pending','retryable_failed') AND a.available_at<=now())
          OR (a.state='leased' AND a.lease_expires_at<now())
        ) AND c.state='resolved' AND c.priority='p0'
        ORDER BY a.available_at,a.created_at,a.id LIMIT ${technologyQuota}
        FOR UPDATE OF a SKIP LOCKED
      ), consult_hr AS MATERIALIZED (
        SELECT a.id FROM job_promotion_attempts a
        JOIN job_discovery_candidates c ON c.id=a.candidate_id
        WHERE ((a.state IN ('pending','retryable_failed') AND a.available_at<=now())
          OR (a.state='leased' AND a.lease_expires_at<now()))
          AND c.state='resolved' AND c.priority='p1'
        ORDER BY a.available_at,a.created_at,a.id LIMIT ${consultHrQuota}
        FOR UPDATE OF a SKIP LOCKED
      ), other_industries AS MATERIALIZED (
        SELECT a.id FROM job_promotion_attempts a
        JOIN job_discovery_candidates c ON c.id=a.candidate_id
        WHERE ((a.state IN ('pending','retryable_failed') AND a.available_at<=now())
          OR (a.state='leased' AND a.lease_expires_at<now()))
          AND c.state='resolved' AND c.priority IN ('p2','p3')
        ORDER BY a.available_at,a.created_at,a.id LIMIT ${otherQuota}
        FOR UPDATE OF a SKIP LOCKED
      ), reserved AS MATERIALIZED (
        SELECT id FROM technology UNION ALL SELECT id FROM consult_hr UNION ALL SELECT id FROM other_industries
      ), borrowed AS MATERIALIZED (
        SELECT a.id FROM job_promotion_attempts a
        JOIN job_discovery_candidates c ON c.id=a.candidate_id
        WHERE ((a.state IN ('pending','retryable_failed') AND a.available_at<=now())
          OR (a.state='leased' AND a.lease_expires_at<now())) AND c.state='resolved'
          AND NOT EXISTS(SELECT 1 FROM reserved WHERE reserved.id=a.id)
        ORDER BY a.available_at,a.created_at,a.id
        LIMIT GREATEST(0,${safeLimit}-(SELECT count(*) FROM reserved))
        FOR UPDATE OF a SKIP LOCKED
      ), candidates AS (
        SELECT id FROM reserved UNION ALL SELECT id FROM borrowed
      ) UPDATE job_promotion_attempts a SET state='leased',lease_owner=${workerId},leased_at=now(),
        lease_expires_at=now()+(${leaseMs}::text||' milliseconds')::interval,
        attempt_count=a.attempt_count+1,updated_at=now()
      FROM candidates WHERE a.id=candidates.id
      RETURNING a.id,a.candidate_id,a.idempotency_key,a.state,a.available_at,a.lease_owner,
        a.lease_expires_at,a.attempt_count,a.failure_stage,a.last_error`.execute(this.db);
    return claimed.rows.map(promotionView);
  }

  async claimPromotionAttemptById(
    attemptId: string,
    workerId: string,
    leaseMs = 5 * 60_000,
  ): Promise<JobPromotionAttempt | null> {
    const claimed = await sql<PromotionRow>`UPDATE job_promotion_attempts attempt SET
        state='leased',lease_owner=${workerId},leased_at=now(),
        lease_expires_at=now()+(${leaseMs}::text||' milliseconds')::interval,
        attempt_count=attempt.attempt_count+1,updated_at=now()
      FROM job_discovery_candidates candidate
      WHERE attempt.id=${attemptId}::uuid AND candidate.id=attempt.candidate_id AND candidate.state='resolved'
        AND ((attempt.state IN ('pending','retryable_failed') AND attempt.available_at<=now())
          OR (attempt.state='leased' AND attempt.lease_expires_at<now()))
      RETURNING attempt.id,attempt.candidate_id,attempt.idempotency_key,attempt.state,attempt.available_at,
        attempt.lease_owner,attempt.lease_expires_at,attempt.attempt_count,attempt.failure_stage,attempt.last_error`.execute(this.db);
    const row = claimed.rows[0];
    return row === undefined ? null : promotionView(row);
  }

  async failPromotion(
    attemptId: string,
    workerId: string,
    stage: string,
    message: string,
    retryAt?: Date,
  ): Promise<void> {
    const terminal = retryAt === undefined;
    const result = await sql`UPDATE job_promotion_attempts SET
      state=${terminal ? "terminal_failed" : "retryable_failed"}::job_promotion_attempt_state,
      failure_stage=${stage},last_error=${message},available_at=${retryAt?.toISOString() ?? new Date().toISOString()}::timestamptz,
      lease_owner=NULL,leased_at=NULL,lease_expires_at=NULL,
      completed_at=CASE WHEN ${terminal} THEN now() ELSE NULL END,updated_at=now()
      WHERE id=${attemptId}::uuid AND state='leased' AND lease_owner=${workerId}`.execute(this.db);
    if (Number(result.numAffectedRows) !== 1) throw new Error("Promotion attempt lease is not owned by this worker");
  }

  async completePromotion(
    attemptId: string,
    workerId: string,
    sourceJobRecordId: string,
    canonicalJobId: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const valid = await sql<{ candidate_id: string }>`SELECT a.candidate_id
        FROM job_promotion_attempts a
        JOIN job_discovery_candidates c ON c.id=a.candidate_id AND c.state='resolved'
        JOIN source_job_records r ON r.id=${sourceJobRecordId}::uuid
          AND r.source_instance_id=c.resolved_source_instance_id AND r.lifecycle_state='active'
        JOIN source_instances s ON s.id=r.source_instance_id AND s.verification_state='verified'
        JOIN company_source_relationships csr ON csr.source_instance_id=s.id
          AND csr.verification_state='verified' AND csr.valid_to IS NULL
        JOIN evidence e ON e.company_source_relationship_id=csr.id
        JOIN canonical_job_sources cjs ON cjs.source_job_record_id=r.id AND cjs.canonical_job_id=${canonicalJobId}::uuid
          AND cjs.active_to IS NULL
        JOIN canonical_jobs cj ON cj.id=cjs.canonical_job_id AND cj.lifecycle_state='active'
        WHERE a.id=${attemptId}::uuid AND a.state='leased' AND a.lease_owner=${workerId}
        LIMIT 1 FOR UPDATE OF a,c`.execute(trx);
      const candidateId = valid.rows[0]?.candidate_id;
      if (candidateId === undefined) throw new Error("Promotion completion requires an active verified official source and Canonical link");
      await sql`UPDATE job_promotion_attempts SET state='succeeded',source_job_record_id=${sourceJobRecordId}::uuid,
        canonical_job_id=${canonicalJobId}::uuid,lease_owner=NULL,leased_at=NULL,lease_expires_at=NULL,
        completed_at=now(),updated_at=now() WHERE id=${attemptId}::uuid`.execute(trx);
      await sql`UPDATE job_discovery_candidates SET state='promoted',promoted_source_job_record_id=${sourceJobRecordId}::uuid,
        rejection_reason=NULL,updated_at=now() WHERE id=${candidateId}::uuid`.execute(trx);
    });
  }

  async expireStale(now = new Date()): Promise<number> {
    const result = await sql`UPDATE job_discovery_candidates SET state='expired',
      rejection_reason='freshness_window_elapsed',updated_at=now()
      WHERE state IN ('discovered','resolving') AND origin_kind<>'official_collection'
        AND last_seen_at<${new Date(now.getTime() - 30 * 86_400_000).toISOString()}::timestamptz`.execute(this.db);
    return Number(result.numAffectedRows);
  }

  async summary(now = new Date()): Promise<DiscoverySummary> {
    const officialCutoff = new Date(now.getTime() - 72 * 60 * 60_000).toISOString();
    const leadCutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const result = await sql<DiscoverySummary>`SELECT
      count(*)::int total,
      count(*) FILTER (WHERE location_state='japan' AND state NOT IN ('rejected','expired') AND (
        (origin_kind='official_collection' AND last_authoritative_import_run_id IS NOT NULL
          AND last_authoritative_seen_at>=${officialCutoff}::timestamptz)
        OR (origin_kind<>'official_collection' AND observation_count>=2 AND last_seen_at>=${leadCutoff}::timestamptz)
      ))::int valid,
      count(*) FILTER (WHERE state='discovered')::int discovered,
      count(*) FILTER (WHERE state='resolving')::int resolving,
      count(*) FILTER (WHERE state='resolved')::int resolved,
      count(*) FILTER (WHERE state='promoted')::int promoted,
      count(*) FILTER (WHERE state='rejected')::int rejected,
      count(*) FILTER (WHERE state='expired')::int expired,
      count(*) FILTER (WHERE location_state='japan')::int japan,
      count(*) FILTER (WHERE location_state='non_japan')::int "nonJapan",
      count(*) FILTER (WHERE location_state='unknown')::int "unknownLocation",
      count(*) FILTER (WHERE source_published_precision IS NOT NULL)::int "publishedKnown"
      FROM job_discovery_candidates`.execute(this.db);
    return result.rows[0] ?? {
      total: 0, valid: 0, discovered: 0, resolving: 0, resolved: 0, promoted: 0,
      rejected: 0, expired: 0, japan: 0, nonJapan: 0, unknownLocation: 0, publishedKnown: 0,
    };
  }

  async list(limit = 100, cursor?: string): Promise<{ candidates: CandidateRow[]; nextCursor: string | null }> {
    const parsedCursor = cursor === undefined ? null : decodeCursor(cursor);
    const result = await sql<CandidateRow>`SELECT * FROM job_discovery_candidates
      WHERE (${parsedCursor?.lastSeenAt ?? null}::timestamptz IS NULL
        OR (last_seen_at,id)<(${parsedCursor?.lastSeenAt ?? null}::timestamptz,${parsedCursor?.id ?? null}::uuid))
      ORDER BY last_seen_at DESC,id DESC LIMIT ${Math.max(1, Math.min(limit, 200))}`.execute(this.db);
    const last = result.rows.at(-1);
    return { candidates: result.rows, nextCursor: last === undefined ? null : encodeCursor(last.last_seen_at, last.id) };
  }

  async detail(candidateId: string): Promise<{ candidate: CandidateRow; observations: unknown[]; attempts: unknown[] }> {
    const [candidate, observations, attempts] = await Promise.all([
      this.loadCandidate(candidateId, this.db),
      sql`SELECT * FROM job_discovery_observations WHERE candidate_id=${candidateId}::uuid
        ORDER BY observed_at DESC,id DESC`.execute(this.db),
      sql`SELECT * FROM job_promotion_attempts WHERE candidate_id=${candidateId}::uuid
        ORDER BY created_at DESC,id DESC`.execute(this.db),
    ]);
    return { candidate, observations: observations.rows, attempts: attempts.rows };
  }

  async promotionAttempts(limit = 100): Promise<unknown[]> {
    return (await sql`SELECT a.*,c.company_name,c.title,c.priority FROM job_promotion_attempts a
      JOIN job_discovery_candidates c ON c.id=a.candidate_id
      ORDER BY a.created_at DESC,a.id DESC LIMIT ${Math.max(1, Math.min(limit, 200))}`.execute(this.db)).rows;
  }

  private async loadCandidate(candidateId: string, executor: Kysely<OutboxDatabase>): Promise<CandidateRow> {
    const result = await sql<CandidateRow>`SELECT * FROM job_discovery_candidates WHERE id=${candidateId}::uuid`.execute(executor);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`Discovery candidate ${candidateId} does not exist`);
    return row;
  }
}

export function classifyJapanLocation(input: string): JobDiscoveryLocationState {
  const value = input.trim();
  if (value === "") return "unknown";
  const nonJapan = /Taiwan|Taipei|South Korea|Seoul|China|Beijing|Shanghai|United States|USA|San Francisco|New York|United Kingdom|\bUK\b|London|Singapore|India|Bengaluru|Australia|Germany|France|台湾|台北|韓国|ソウル|中国|北京|上海/i;
  if (nonJapan.test(value) && !/Japan|日本|\bJP\b/i.test(value)) return "non_japan";
  const japan = /Japan|日本|\bJP\b|全国|北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄|Tokyo|Osaka|Kyoto|Fukuoka|Hokkaido|Kanagawa|Chiba|Saitama|Aichi|Nagoya|Hyogo|Hiroshima|Sendai|Okinawa/i;
  return japan.test(value) ? "japan" : "unknown";
}

export function isCountableCandidate(candidate: CandidateRow, now = new Date()): boolean {
  if (candidate.location_state !== "japan" || candidate.state === "rejected" || candidate.state === "expired") return false;
  if (candidate.origin_kind === "official_collection") {
    return candidate.last_authoritative_import_run_id !== null && candidate.last_authoritative_seen_at !== null
      && candidate.last_authoritative_seen_at.getTime() >= now.getTime() - 72 * 60 * 60_000;
  }
  return candidate.observation_count >= 2 && candidate.last_seen_at.getTime() >= now.getTime() - 30 * 86_400_000;
}

export function weakSimilarityClusterKey(companyName: string, title: string, locationText: string): string {
  return createHash("sha256").update([
    normalizeCompanyName(companyName),
    normalizeWeakText(title),
    normalizeWeakText(locationText),
  ].join("\0")).digest("hex");
}

function strongKey(lead: JobDiscoveryLead, normalizedDetailUrl: string, normalizedOfficialUrl: string | null): string {
  if (normalizedOfficialUrl !== null) return `official:${normalizedOfficialUrl}`;
  if (lead.tenantKey !== undefined && lead.externalPostingId !== undefined) {
    return `external:${lead.sourceFamily}:${lead.tenantKey}:${lead.externalPostingId}`;
  }
  return `detail:${normalizedDetailUrl}`;
}

function normalizeCompanyName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/株式会社|有限会社|合同会社|inc\.?|ltd\.?|corp\.?/gi, "")
    .replace(/[^\p{L}\p{N}]+/gu, "").trim();
}

function normalizeWeakText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function preferOrigin(current: JobDiscoveryLead["originKind"], incoming: JobDiscoveryLead["originKind"]): JobDiscoveryLead["originKind"] {
  const priority: Record<JobDiscoveryLead["originKind"], number> = {
    official_collection: 4,
    official_single_record: 3,
    search_index: 2,
    aggregator_lead: 1,
  };
  return priority[incoming] > priority[current] ? incoming : current;
}

function promotionView(row: PromotionRow): JobPromotionAttempt {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    availableAt: row.available_at.toISOString(),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    attemptCount: row.attempt_count,
    failureStage: row.failure_stage,
    lastError: row.last_error,
  };
}

function encodeCursor(lastSeenAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ lastSeenAt: lastSeenAt.toISOString(), id }), "utf8").toString("base64url");
}

function decodeCursor(value: string): { lastSeenAt: string; id: string } {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
  if (typeof parsed.lastSeenAt !== "string" || typeof parsed.id !== "string") throw new Error("Invalid discovery cursor");
  return { lastSeenAt: parsed.lastSeenAt, id: parsed.id };
}

async function validatedAuthoritativeRun(
  executor: Kysely<OutboxDatabase>,
  runId: string | undefined,
  discoverySourceId: string,
): Promise<string> {
  if (runId === undefined) throw new Error("Authoritative Discovery observations require a finalized import run");
  const result = await sql<{ id: string }>`SELECT id FROM discovery_import_runs
    WHERE id=${runId}::uuid AND discovery_source_id=${discoverySourceId}::uuid AND status='succeeded'
      AND validation_result->>'snapshotKind'='authoritative'
      AND COALESCE((validation_result->>'allPagesCompleted')::boolean,false)
      AND COALESCE((validation_result->>'tenantIdentityConsistent')::boolean,false)
      AND COALESCE((validation_result->>'providerTotalMatched')::boolean,false)
      AND COALESCE(jsonb_array_length(validation_result->'parseErrors'),0)=0`.execute(executor);
  if (result.rows[0] === undefined) throw new Error("Discovery import is not a complete authoritative snapshot");
  return result.rows[0].id;
}
