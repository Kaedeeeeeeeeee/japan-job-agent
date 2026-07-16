import { createHash, randomUUID } from "node:crypto";
import {
  Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Put, Query,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { z } from "zod";
import type { SafeProfile } from "../../../packages/profile/src/build-profile.js";
import { evaluateJob, type JobMatchResult } from "../../../packages/matching/src/evaluate-job.js";
import {
  classifyOccupation,
  OCCUPATION_TAXONOMY_VERSION,
  occupationFamilyFacets,
} from "../../../packages/occupations/src/occupation-taxonomy-v1.js";
import { DatabaseService } from "./database.service.js";
import { evaluateRefreshPolicy, type RefreshPolicyResult } from "../../../packages/refresh/src/refresh-policy.js";
import { sourceSyncWorkflow } from "../../../packages/workflows/src/source-sync-workflow.js";
import { createAiProviderFromEnv, MATCH_EXPLANATION_PROMPT_VERSION } from "../../../packages/ai/src/ai-provider.js";
import { AiTaskService } from "../../../packages/ai/src/ai-task-service.js";
import {
  enqueueProfileEmbedding,
  enqueueRecommendationExplanation,
} from "../../../packages/ai/src/ai-task-processor.js";

const USER_KEY = "github:Kaedeeeeeeeeee";
const RANKING_VERSION = "deterministic-v2";
const STRUCTURED_RETRIEVAL_VERSION = "structured-all-v1";
const SEMANTIC_RETRIEVAL_VERSION = "semantic-top200-v1";

interface ProfileRow { profile_version_id: string; structured_profile: SafeProfile; source_fingerprint: string }
interface JobRow {
  canonical_job_id: string;
  canonical_job_version_id: string;
  readiness: "ready" | "pending_enrichment" | "needs_review";
  readiness_reasons: string[];
  lifecycle_state: "active" | "suspect" | "closed";
  title: string;
  application_url: string;
  structured_result: Record<string, unknown>;
  verified_official_source: boolean;
  company_name: string | null;
  source_kind: string;
  source_key: string;
  fetched_at: Date;
  first_seen_at: Date;
  last_seen_at: Date;
  published_state: "known" | "unknown" | "conflicting" | null;
  published_precision: "date" | "datetime" | null;
  published_date: string | null;
  published_at: Date | null;
  published_evidence_ids: string[] | null;
  source_updated_state: "known" | "unknown" | "conflicting" | null;
  source_updated_precision: "date" | "datetime" | null;
  source_updated_date: string | null;
  source_updated_at: Date | null;
  source_updated_evidence_ids: string[] | null;
  valid_through_state: "known" | "unknown" | "conflicting" | null;
  valid_through_precision: "date" | "datetime" | null;
  valid_through_date: string | null;
  valid_through_at: Date | null;
  valid_through_evidence_ids: string[] | null;
  source_health: string;
  source_instance_id: string;
  interval_hours: number;
  stale_refresh_allowed: boolean;
  saved: boolean;
  hidden: boolean;
  applied_at: Date | null;
  ai_explanation_status: "pending" | "succeeded" | "failed" | null;
  ai_explanation: Record<string, unknown> | null;
  ai_explanation_error: string | null;
}
interface RefreshCandidateRow {
  canonical_job_id: string;
  lifecycle_state: "active" | "suspect" | "closed";
  source_instance_id: string;
  source_kind: string;
  fetched_at: Date;
  interval_hours: number;
  stale_refresh_allowed: boolean;
  source_verified: boolean;
  saved: boolean;
  applied: boolean;
}
interface EvidenceRow {
  canonical_job_version_id: string;
  field_path: string;
  evidence_id: string;
  quoted_text: string;
  source_url: string;
  locator: Record<string, unknown>;
}
interface RetrievalContext {
  version: string;
  embeddingModelKey: string | null;
  recalledJobVersionIds: string[] | null;
}

const stateInput = z.object({
  saved: z.boolean().optional(),
  hidden: z.boolean().optional(),
  applied: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one state must be provided");

@Controller("/agent")
export class AgentController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Get("/jobs")
  async jobs(@Query("view") view = "recommendations") {
    const profileResult = await this.database.query<ProfileRow>(`SELECT pv.id profile_version_id,pv.structured_profile,pv.source_fingerprint
      FROM profiles p JOIN profile_versions pv ON pv.id=p.current_version_id WHERE p.profile_key='primary'`);
    const profileRow = profileResult.rows[0];
    if (profileRow === undefined) return {
      profileConfigured: false,
      occupationTaxonomyVersion: OCCUPATION_TAXONOMY_VERSION,
      facets: { occupations: [] },
      jobs: [],
    };
    const retrieval = await this.resolveRetrieval(profileRow.profile_version_id, profileRow.source_fingerprint, view);
    const jobs = await this.loadJobs(view, profileRow.profile_version_id, retrieval);
    const evidenceRows = jobs.length === 0 ? [] : (await this.database.query<EvidenceRow>(`SELECT
      cfe.canonical_job_version_id,cfe.field_path,e.id evidence_id,e.quoted_text,e.source_url,e.locator
      FROM canonical_field_evidence cfe JOIN evidence e ON e.id=cfe.evidence_id
      WHERE cfe.canonical_job_version_id=ANY($1::uuid[])
      ORDER BY cfe.canonical_job_version_id,e.created_at,e.id`, [jobs.map((job) => job.canonical_job_version_id)])).rows;
    const evidenceByVersion = Map.groupBy(evidenceRows, (evidence) => evidence.canonical_job_version_id);
    const output = [];
    for (const row of jobs) {
      const currentEvidence = evidenceByVersion.get(row.canonical_job_version_id) ?? [];
      const evidenceByField: Record<string, string[]> = {};
      for (const evidence of currentEvidence) evidenceByField[evidence.field_path] = [...(evidenceByField[evidence.field_path] ?? []), evidence.evidence_id];
      const descriptionText = typeof row.structured_result.descriptionText === "string"
        ? row.structured_result.descriptionText
        : undefined;
      const occupation = classifyOccupation({
        title: row.title,
        ...(descriptionText === undefined ? {} : { descriptionText }),
      });
      const match = evaluateJob(profileRow.structured_profile, {
        canonicalJobId: row.canonical_job_id, canonicalJobVersionId: row.canonical_job_version_id,
        lifecycleState: row.lifecycle_state, verifiedOfficialSource: row.verified_official_source,
        readiness: row.readiness,
        title: row.title, applicationUrl: row.application_url, fetchedAt: row.fetched_at.toISOString(), occupation,
        structured: row.structured_result, evidenceByField,
      });
      output.push({
        title: row.title, companyName: row.company_name ?? row.source_key,
        applicationUrl: row.application_url, sourceKind: row.source_kind, sourceKey: row.source_key,
        fetchedAt: row.fetched_at.toISOString(), sourceHealth: row.source_health,
        occupation,
        readiness: row.readiness,
        readinessReasons: row.readiness_reasons,
        fieldStates: fieldStates(row.structured_result, row.readiness),
        explanation: {
          status: row.ai_explanation_status ?? "deterministic",
          source: row.ai_explanation_status === "succeeded" ? "ai" : "deterministic",
          summary: typeof row.ai_explanation?.summary === "string" ? row.ai_explanation.summary : null,
          matched: Array.isArray(row.ai_explanation?.matched) ? row.ai_explanation.matched : null,
          gaps: Array.isArray(row.ai_explanation?.gaps) ? row.ai_explanation.gaps : null,
          error: row.ai_explanation_status === "failed" ? row.ai_explanation_error : null,
        },
        dates: {
          published: {
            state: row.published_state ?? "unknown",
            value: row.published_precision === "date" ? row.published_date
              : row.published_at?.toISOString() ?? null,
            precision: row.published_precision,
            evidenceIds: row.published_evidence_ids ?? [],
          },
          sourceUpdated: {
            state: row.source_updated_state ?? "unknown",
            value: row.source_updated_precision === "date" ? row.source_updated_date
              : row.source_updated_at?.toISOString() ?? null,
            precision: row.source_updated_precision,
            evidenceIds: row.source_updated_evidence_ids ?? [],
          },
          validThrough: {
            state: row.valid_through_state ?? "unknown",
            value: row.valid_through_precision === "date" ? row.valid_through_date
              : row.valid_through_at?.toISOString() ?? null,
            precision: row.valid_through_precision,
            evidenceIds: row.valid_through_evidence_ids ?? [],
          },
          firstSeenAt: row.first_seen_at.toISOString(),
          lastSeenAt: row.last_seen_at.toISOString(),
          fetchedAt: row.fetched_at.toISOString(),
          display: row.published_precision !== null && (row.published_date !== null || row.published_at !== null)
            ? { kind: "published", value: row.published_precision === "date" ? row.published_date! : row.published_at!.toISOString() }
            : { kind: "first_seen", value: row.first_seen_at.toISOString() },
        },
        state: { saved: row.saved, hidden: row.hidden, appliedAt: row.applied_at?.toISOString() ?? null },
        refresh: evaluateRefreshPolicy({
          lifecycleState: row.lifecycle_state, saved: row.saved, applied: row.applied_at !== null,
          sourceVerified: row.verified_official_source, sourceKind: row.source_kind,
          staleRefreshAllowed: row.stale_refresh_allowed, fetchedAt: row.fetched_at,
          intervalHours: row.interval_hours, now: new Date(),
        }),
        evidence: currentEvidence.map((value) => ({
          id: value.evidence_id, field: value.field_path, quote: value.quoted_text,
          sourceUrl: value.source_url, locator: value.locator,
        })),
        ...match,
      });
    }
    output.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title, "ja"));
    const visible = output.filter((job) => this.inView(job, view));
    const persisted = await this.persistRun(profileRow.profile_version_id, output, retrieval);
    for (const job of output) {
      const status = persisted.explanationStatuses.get(job.canonicalJobVersionId);
      if (status !== undefined) job.explanation.status = status;
    }
    return {
      profileConfigured: true, rankingVersion: RANKING_VERSION, retrievalVersion: retrieval.version,
      embeddingModelKey: retrieval.embeddingModelKey, recommendationRunId: persisted.recommendationRunId,
      occupationTaxonomyVersion: OCCUPATION_TAXONOMY_VERSION,
      facets: { occupations: occupationFamilyFacets(visible.map((job) => job.occupation)).filter((facet) => facet.count > 0) },
      generatedAt: new Date().toISOString(), total: output.length, visible: visible.length, jobs: visible,
    };
  }

  @Get("/profile")
  async profile() {
    const result = await this.database.query<ProfileRow>(`SELECT pv.id profile_version_id,pv.structured_profile,pv.source_fingerprint
      FROM profiles p JOIN profile_versions pv ON pv.id=p.current_version_id WHERE p.profile_key='primary'`);
    return result.rows[0] ?? null;
  }

  @Get("/recommendation-runs/:id/explanations")
  async explanationStatuses(@Param("id") rawRunId: string) {
    const recommendationRunId = z.string().uuid().parse(rawRunId);
    const run = await this.database.query<{ id: string }>("SELECT id FROM recommendation_runs WHERE id=$1 AND user_key=$2",
      [recommendationRunId, USER_KEY]);
    if (run.rows[0] === undefined) throw new NotFoundException("Recommendation Run does not exist");
    const results = await this.database.query<{
      canonical_job_id: string;
      canonical_job_version_id: string;
      rank: number;
      explanation_status: "deterministic" | "pending" | "succeeded" | "failed";
      explanation: Record<string, unknown> | null;
      last_error: string | null;
    }>(`SELECT result.canonical_job_id,result.canonical_job_version_id,result.rank,result.explanation_status,
      cache.explanation,cache.last_error
      FROM recommendation_results result
      LEFT JOIN recommendation_runs run ON run.id=result.recommendation_run_id
      LEFT JOIN recommendation_explanations cache ON cache.profile_version_id=run.profile_version_id
        AND cache.canonical_job_version_id=result.canonical_job_version_id AND cache.prompt_version=$2
      WHERE result.recommendation_run_id=$1 ORDER BY result.rank`, [recommendationRunId, MATCH_EXPLANATION_PROMPT_VERSION]);
    return {
      recommendationRunId,
      pending: results.rows.filter((row) => row.explanation_status === "pending").length,
      complete: results.rows.every((row) => row.explanation_status !== "pending"),
      results: results.rows.map((row) => ({
        canonicalJobId: row.canonical_job_id,
        canonicalJobVersionId: row.canonical_job_version_id,
        rank: row.rank,
        status: row.explanation_status,
        explanation: row.explanation,
        error: row.last_error,
      })),
    };
  }

  @Put("/jobs/:id/state")
  async updateState(@Param("id") id: string, @Body() body: unknown) {
    const canonicalJobId = z.string().uuid().parse(id);
    const input = stateInput.parse(body);
    const appliedAt = input.applied === undefined ? undefined : input.applied ? new Date() : null;
    const result = await this.database.query<{ saved: boolean; hidden: boolean; applied_at: Date | null }>(`INSERT INTO job_user_states(
        user_key,canonical_job_id,saved,hidden,applied_at
      ) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT(user_key,canonical_job_id) DO UPDATE SET
        saved=COALESCE($6,job_user_states.saved), hidden=COALESCE($7,job_user_states.hidden),
        applied_at=CASE WHEN $8::boolean IS NULL THEN job_user_states.applied_at ELSE $9::timestamptz END, updated_at=now()
      RETURNING saved,hidden,applied_at`, [
      USER_KEY, canonicalJobId, input.saved ?? false, input.hidden ?? false, appliedAt ?? null,
      input.saved ?? null, input.hidden ?? null, input.applied ?? null, appliedAt ?? null,
    ]);
    const state = result.rows[0];
    const refresh = await this.refreshPolicy(canonicalJobId);
    return {
      canonicalJobId, saved: state?.saved ?? false, hidden: state?.hidden ?? false,
      appliedAt: state?.applied_at?.toISOString() ?? null, refresh,
    };
  }

  @Post("/jobs/:id/refresh")
  @HttpCode(202)
  async requestRefresh(@Param("id") id: string) {
    const canonicalJobId = z.string().uuid().parse(id);
    const candidate = await this.refreshCandidate(canonicalJobId);
    if (candidate === undefined) throw new NotFoundException("Canonical Job does not exist");
    const policy = policyFor(candidate);
    if (!policy.eligible) throw new ConflictException({ error: "refresh_not_allowed", reason: policy.reason, staleAt: policy.staleAt });

    const hourBucket = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
    const requestKey = createHash("sha256").update(`${USER_KEY}\0${candidate.source_instance_id}\0${hourBucket}`).digest("hex");
    const requestId = randomUUID();
    const inserted = await this.database.query<{ id: string; status: string; temporal_workflow_id: string | null }>(`INSERT INTO on_demand_refresh_requests(
        id,user_key,canonical_job_id,source_instance_id,request_key,status
      ) VALUES ($1,$2,$3,$4,$5,'requested')
      ON CONFLICT(user_key,request_key) DO NOTHING RETURNING id,status,temporal_workflow_id`, [
      requestId, USER_KEY, canonicalJobId, candidate.source_instance_id, requestKey,
    ]);
    let request = inserted.rows[0];
    const deduplicated = request === undefined;
    if (request === undefined) {
      const existing = await this.database.query<{ id: string; status: string; temporal_workflow_id: string | null }>(
        "SELECT id,status,temporal_workflow_id FROM on_demand_refresh_requests WHERE user_key=$1 AND request_key=$2",
        [USER_KEY, requestKey],
      );
      request = existing.rows[0];
      if (request === undefined) throw new ServiceUnavailableException("Refresh request could not be recovered");
      if (request.status === "failed") {
        throw new ServiceUnavailableException({ error: "recent_refresh_failed", requestId: request.id });
      }
      if (request.status !== "requested") return { accepted: true, deduplicated: true, request };
    }

    const persistedRequestId = request.id;
    const workflowId = `on-demand-refresh-${persistedRequestId}`;
    let connection: Connection | undefined;
    try {
      connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233" });
      const temporal = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default" });
      try {
        await temporal.workflow.start(sourceSyncWorkflow, {
          taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "japan-job-agent",
          workflowId,
          args: [{ sourceInstanceId: candidate.source_instance_id, refreshRequestId: persistedRequestId }],
        });
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      }
    } catch (error) {
      await this.database.query(`UPDATE on_demand_refresh_requests SET status='failed',temporal_workflow_id=$2,
        completed_at=now(),failure_code='temporal_start_failed',failure_detail=$3::jsonb
        WHERE id=$1 AND status='requested'`, [
        persistedRequestId, workflowId, JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
      ]);
      throw new ServiceUnavailableException("Refresh workflow could not be started");
    } finally {
      await connection?.close();
    }
    await this.database.query(`UPDATE on_demand_refresh_requests SET status='started',temporal_workflow_id=$2,started_at=now()
      WHERE id=$1 AND status='requested'`, [persistedRequestId, workflowId]);
    return {
      accepted: true,
      deduplicated,
      request: { id: persistedRequestId, status: "started", temporal_workflow_id: workflowId },
    };
  }

  private async resolveRetrieval(profileVersionId: string, sourceFingerprint: string, view: string): Promise<RetrievalContext> {
    if (view !== "recommendations" || process.env.SEMANTIC_RETRIEVAL_ENABLED !== "true") {
      return { version: STRUCTURED_RETRIEVAL_VERSION, embeddingModelKey: null, recalledJobVersionIds: null };
    }
    const provider = createAiProviderFromEnv();
    if (provider === null) return { version: STRUCTURED_RETRIEVAL_VERSION, embeddingModelKey: null, recalledJobVersionIds: null };
    const profileEmbedding = await this.database.query<{ embedding_text: string; dimensions: number }>(`SELECT embedding::text embedding_text,dimensions
      FROM profile_embeddings WHERE profile_version_id=$1 AND model_key=$2 ORDER BY created_at DESC LIMIT 1`,
    [profileVersionId, provider.embeddingModelKey]);
    const embedding = profileEmbedding.rows[0];
    if (embedding === undefined) {
      await enqueueProfileEmbedding(new AiTaskService(this.database.kysely), provider, profileVersionId, sourceFingerprint);
      return { version: `${SEMANTIC_RETRIEVAL_VERSION}:profile-pending-fallback`,
        embeddingModelKey: provider.embeddingModelKey, recalledJobVersionIds: null };
    }
    const recalled = await this.database.query<{ canonical_job_version_id: string }>(`SELECT embedded.canonical_job_version_id
      FROM canonical_job_embeddings embedded
      JOIN canonical_jobs job ON job.current_version_id=embedded.canonical_job_version_id
      JOIN canonical_job_versions version ON version.id=embedded.canonical_job_version_id
      WHERE embedded.model_key=$1 AND embedded.dimensions=$2 AND version.readiness='ready'
      ORDER BY embedded.embedding <=> $3::vector,embedded.canonical_job_version_id
      LIMIT 200`, [provider.embeddingModelKey, embedding.dimensions, embedding.embedding_text]);
    return { version: SEMANTIC_RETRIEVAL_VERSION, embeddingModelKey: provider.embeddingModelKey,
      recalledJobVersionIds: recalled.rows.map((row) => row.canonical_job_version_id) };
  }

  private async loadJobs(_view: string, profileVersionId: string, retrieval: RetrievalContext): Promise<JobRow[]> {
    const result = await this.database.query<JobRow>(`SELECT c.id canonical_job_id,v.id canonical_job_version_id,
      c.lifecycle_state,v.title,v.application_url,v.structured_result,v.readiness,v.readiness_reasons,
      source.fetched_at,source.first_seen_at,source.last_seen_at,source.source_kind,
      source.tenant_key source_key,source.health_state source_health,company.display_name company_name,
      published.published_state,published.published_precision,published.published_date,
      published.published_at,published.published_evidence_ids,
      source_updated.source_updated_state,source_updated.source_updated_precision,
      source_updated.source_updated_date,source_updated.source_updated_at,source_updated.source_updated_evidence_ids,
      valid_through.valid_through_state,valid_through.valid_through_precision,
      valid_through.valid_through_date,valid_through.valid_through_at,valid_through.valid_through_evidence_ids,
      source.source_instance_id,schedule.interval_hours,schedule.stale_refresh_allowed,
      COALESCE(state.saved,false) saved,COALESCE(state.hidden,false) hidden,state.applied_at,
      explanation.status ai_explanation_status,explanation.explanation ai_explanation,
      explanation.last_error ai_explanation_error,
      EXISTS(SELECT 1 FROM canonical_job_sources verified_cjs
        JOIN source_job_records verified_record ON verified_record.id=verified_cjs.source_job_record_id
        JOIN source_instances verified_source ON verified_source.id=verified_record.source_instance_id
        JOIN company_source_relationships csr ON csr.source_instance_id=verified_source.id
        WHERE verified_cjs.canonical_job_id=c.id AND verified_cjs.active_to IS NULL
          AND verified_source.verification_state='verified' AND csr.verification_state='verified' AND csr.valid_to IS NULL
      ) verified_official_source
      FROM canonical_jobs c JOIN canonical_job_versions v ON v.id=c.current_version_id
      JOIN LATERAL (SELECT si.source_kind,si.tenant_key,si.health_state,sjr.first_seen_at,sjr.last_seen_at,
          COALESCE((SELECT raw.fetched_at FROM source_job_versions raw
            WHERE raw.source_job_record_id=sjr.id ORDER BY raw.fetched_at DESC,raw.id DESC LIMIT 1),sjr.last_seen_at) fetched_at,
          sjr.source_instance_id
        FROM canonical_job_sources cjs JOIN source_job_records sjr ON sjr.id=cjs.source_job_record_id
        JOIN source_instances si ON si.id=sjr.source_instance_id
        WHERE cjs.canonical_job_id=c.id AND cjs.source_role='primary' AND cjs.active_to IS NULL
        LIMIT 1) source ON true
      LEFT JOIN LATERAL (SELECT ds.value_state published_state,d.precision published_precision,
        d.date_value::text published_date,d.timestamp_value published_at,
        ARRAY(SELECT DISTINCT all_dates.evidence_id::text FROM canonical_job_dates all_dates
          WHERE all_dates.canonical_job_version_id=v.id AND all_dates.date_kind='published'
            AND all_dates.evidence_id IS NOT NULL ORDER BY all_dates.evidence_id::text) published_evidence_ids
        FROM canonical_job_date_states ds
        LEFT JOIN canonical_job_dates d ON d.canonical_job_version_id=ds.canonical_job_version_id
          AND d.date_kind=ds.date_kind
        WHERE ds.canonical_job_version_id=v.id AND ds.date_kind='published'
        ORDER BY (d.source_role='primary') DESC NULLS LAST,d.id LIMIT 1) published ON true
      LEFT JOIN LATERAL (SELECT ds.value_state source_updated_state,d.precision source_updated_precision,
        d.date_value::text source_updated_date,d.timestamp_value source_updated_at,
        ARRAY(SELECT DISTINCT all_dates.evidence_id::text FROM canonical_job_dates all_dates
          WHERE all_dates.canonical_job_version_id=v.id AND all_dates.date_kind='source_updated'
            AND all_dates.evidence_id IS NOT NULL ORDER BY all_dates.evidence_id::text) source_updated_evidence_ids
        FROM canonical_job_date_states ds
        LEFT JOIN canonical_job_dates d ON d.canonical_job_version_id=ds.canonical_job_version_id
          AND d.date_kind=ds.date_kind
        WHERE ds.canonical_job_version_id=v.id AND ds.date_kind='source_updated'
        ORDER BY (d.source_role='primary') DESC NULLS LAST,d.id LIMIT 1) source_updated ON true
      LEFT JOIN LATERAL (SELECT ds.value_state valid_through_state,d.precision valid_through_precision,
        d.date_value::text valid_through_date,d.timestamp_value valid_through_at,
        ARRAY(SELECT DISTINCT all_dates.evidence_id::text FROM canonical_job_dates all_dates
          WHERE all_dates.canonical_job_version_id=v.id AND all_dates.date_kind='valid_through'
            AND all_dates.evidence_id IS NOT NULL ORDER BY all_dates.evidence_id::text) valid_through_evidence_ids
        FROM canonical_job_date_states ds
        LEFT JOIN canonical_job_dates d ON d.canonical_job_version_id=ds.canonical_job_version_id
          AND d.date_kind=ds.date_kind
        WHERE ds.canonical_job_version_id=v.id AND ds.date_kind='valid_through'
        ORDER BY (d.source_role='primary') DESC NULLS LAST,d.id LIMIT 1) valid_through ON true
      LEFT JOIN LATERAL (SELECT co.display_name FROM company_source_relationships csr JOIN companies co ON co.id=csr.company_id
        WHERE csr.source_instance_id=source.source_instance_id AND csr.verification_state='verified' AND csr.valid_to IS NULL
        ORDER BY csr.valid_from DESC LIMIT 1) company ON true
      JOIN source_schedules schedule ON schedule.source_instance_id=source.source_instance_id
      LEFT JOIN job_user_states state ON state.canonical_job_id=c.id AND state.user_key=$1
      LEFT JOIN recommendation_explanations explanation
        ON explanation.profile_version_id=$2::uuid AND explanation.canonical_job_version_id=v.id
        AND explanation.prompt_version=$5
      WHERE ($3::uuid[] IS NULL OR v.id=ANY($3::uuid[]) OR (
        v.readiness='ready' AND NOT EXISTS(
          SELECT 1 FROM canonical_job_embeddings embedded
          WHERE embedded.canonical_job_version_id=v.id AND embedded.model_key=$4
        )
      ))`, [USER_KEY, profileVersionId, retrieval.recalledJobVersionIds,
      retrieval.embeddingModelKey, MATCH_EXPLANATION_PROMPT_VERSION]);
    return result.rows;
  }

  private async refreshPolicy(canonicalJobId: string): Promise<RefreshPolicyResult | null> {
    const candidate = await this.refreshCandidate(canonicalJobId);
    return candidate === undefined ? null : policyFor(candidate);
  }

  private async refreshCandidate(canonicalJobId: string): Promise<RefreshCandidateRow | undefined> {
    const result = await this.database.query<RefreshCandidateRow>(`SELECT c.id canonical_job_id,c.lifecycle_state,
      source.source_instance_id,source.source_kind,source.fetched_at,schedule.interval_hours,schedule.stale_refresh_allowed,
      COALESCE(state.saved,false) saved,state.applied_at IS NOT NULL applied,
      (source.verification_state='verified' AND EXISTS(
        SELECT 1 FROM company_source_relationships csr WHERE csr.source_instance_id=source.source_instance_id
          AND csr.verification_state='verified' AND csr.valid_to IS NULL)) source_verified
      FROM canonical_jobs c
      JOIN LATERAL (SELECT si.id source_instance_id,si.source_kind,si.verification_state,sjr.last_seen_at fetched_at
        FROM canonical_job_sources cjs JOIN source_job_records sjr ON sjr.id=cjs.source_job_record_id
        JOIN source_instances si ON si.id=sjr.source_instance_id
        WHERE cjs.canonical_job_id=c.id AND cjs.source_role='primary' AND cjs.active_to IS NULL
        LIMIT 1) source ON true
      JOIN source_schedules schedule ON schedule.source_instance_id=source.source_instance_id
      LEFT JOIN job_user_states state ON state.canonical_job_id=c.id AND state.user_key=$1
      WHERE c.id=$2`, [USER_KEY, canonicalJobId]);
    return result.rows[0];
  }

  private inView(job: { eligible: boolean; state: { saved: boolean; hidden: boolean; appliedAt: string | null } }, view: string): boolean {
    if (view === "saved") return job.state.saved && !job.state.hidden;
    if (view === "applied") return job.state.appliedAt !== null && !job.state.hidden;
    if (view === "hidden") return job.state.hidden;
    return job.eligible && !job.state.hidden;
  }

  private async persistRun(
    profileVersionId: string,
    jobs: Array<JobMatchResult & { title: string }>,
    retrieval: RetrievalContext,
  ): Promise<{
    recommendationRunId: string;
    explanationStatuses: Map<string, "deterministic" | "pending" | "succeeded" | "failed">;
  }> {
    const inputJobVersionIds = jobs.map((job) => job.canonicalJobVersionId).sort();
    const runKey = createHash("sha256").update(JSON.stringify({
      rankingVersion: RANKING_VERSION, retrievalVersion: retrieval.version,
      embeddingModelKey: retrieval.embeddingModelKey, profileVersionId, inputJobVersionIds,
      inputs: jobs.map((job) => [job.canonicalJobVersionId, job.score]),
    })).digest("hex");
    const runId = randomUUID();
    const recommendationRunId = await this.database.transaction(async (query) => {
      const inserted = await query<{ id: string }>(`INSERT INTO recommendation_runs(
          id,user_key,run_key,profile_version_id,ranking_version,retrieval_version,embedding_model_key,
          input_job_version_ids,eligible_count,input_count
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
        ON CONFLICT(user_key,run_key) DO NOTHING RETURNING id`, [
        runId, USER_KEY, runKey, profileVersionId, RANKING_VERSION, retrieval.version, retrieval.embeddingModelKey,
        JSON.stringify(inputJobVersionIds), jobs.filter((job) => job.eligible).length, jobs.length,
      ]);
      const id = inserted.rows[0]?.id ?? (await query<{ id: string }>(
        "SELECT id FROM recommendation_runs WHERE user_key=$1 AND run_key=$2", [USER_KEY, runKey])).rows[0]?.id;
      if (id === undefined) throw new Error("Recommendation run disappeared");
      if (inserted.rows[0] !== undefined) {
        const rows = jobs.map((job, index) => ({ canonicalJobId: job.canonicalJobId,
          canonicalJobVersionId: job.canonicalJobVersionId, rank: index + 1, score: job.score,
          eligible: job.eligible, scoreBreakdown: job.scoreBreakdown,
          explanation: { matched: job.matched, gaps: job.gaps, unknowns: job.unknowns } }));
        if (rows.length > 0) await query(`INSERT INTO recommendation_results(
            recommendation_run_id,canonical_job_id,canonical_job_version_id,rank,score,eligible,score_breakdown,explanation)
          SELECT $1,x.canonical_job_id,x.canonical_job_version_id,x.rank,x.score,x.eligible,x.score_breakdown,x.explanation
          FROM jsonb_to_recordset($2::jsonb) AS x(canonical_job_id uuid,canonical_job_version_id uuid,
            rank integer,score numeric,eligible boolean,score_breakdown jsonb,explanation jsonb)`, [id,
          JSON.stringify(rows.map((row) => ({ canonical_job_id: row.canonicalJobId,
            canonical_job_version_id: row.canonicalJobVersionId, rank: row.rank, score: row.score,
            eligible: row.eligible, score_breakdown: row.scoreBreakdown, explanation: row.explanation }))) ]);
      }
      return id;
    });
    const explanationStatuses = new Map<string, "deterministic" | "pending" | "succeeded" | "failed">();
    if (process.env.AI_EXPLANATIONS_ENABLED !== "true") return { recommendationRunId, explanationStatuses };
    const provider = createAiProviderFromEnv();
    if (provider === null) return { recommendationRunId, explanationStatuses };
    const tasks = new AiTaskService(this.database.kysely);
    for (const job of jobs.filter((candidate) => candidate.eligible).slice(0, 10)) {
      const inputHash = createHash("sha256").update(JSON.stringify({
        profileVersionId,
        canonicalJobVersionId: job.canonicalJobVersionId,
        score: job.score,
        scoreBreakdown: job.scoreBreakdown,
        matched: job.matched,
        gaps: job.gaps,
        unknowns: job.unknowns,
      })).digest("hex");
      await enqueueRecommendationExplanation(this.database.kysely, tasks, provider, {
        recommendationRunId,
        profileVersionId,
        canonicalJobVersionId: job.canonicalJobVersionId,
        inputHash,
      });
      const status = await this.database.query<{ status: "pending" | "succeeded" | "failed" }>(`SELECT status
        FROM recommendation_explanations WHERE profile_version_id=$1 AND canonical_job_version_id=$2
          AND prompt_version=$3`, [profileVersionId, job.canonicalJobVersionId, MATCH_EXPLANATION_PROMPT_VERSION]);
      const value = status.rows[0]?.status ?? "pending";
      explanationStatuses.set(job.canonicalJobVersionId, value);
      await this.database.query(`UPDATE recommendation_results SET explanation_status=$3
        WHERE recommendation_run_id=$1 AND canonical_job_version_id=$2`,
      [recommendationRunId, job.canonicalJobVersionId, value]);
    }
    return { recommendationRunId, explanationStatuses };
  }
}

function policyFor(row: RefreshCandidateRow): RefreshPolicyResult {
  return evaluateRefreshPolicy({
    lifecycleState: row.lifecycle_state, saved: row.saved, applied: row.applied,
    sourceVerified: row.source_verified, sourceKind: row.source_kind,
    staleRefreshAllowed: row.stale_refresh_allowed, fetchedAt: row.fetched_at,
    intervalHours: row.interval_hours, now: new Date(),
  });
}

function fieldStates(structured: Record<string, unknown>, readiness: JobRow["readiness"]): Record<string, {
  state: "known" | "unknown" | "conflicting";
  unknownReason: string | null;
  processing: boolean;
}> {
  return Object.fromEntries(["employmentTypes", "locations", "skills", "languages", "compensation", "visaSupport"]
    .map((field) => {
      const value = structured[field];
      const fact = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
      const state = fact.state === "known" || fact.state === "conflicting" ? fact.state : "unknown";
      return [field, {
        state,
        unknownReason: state === "unknown" && typeof fact.unknownReason === "string" ? fact.unknownReason : null,
        processing: state === "unknown" && readiness === "pending_enrichment",
      }];
    }));
}
