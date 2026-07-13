import { createHash, randomUUID } from "node:crypto";
import { Body, Controller, Get, Inject, Param, Put, Query } from "@nestjs/common";
import { z } from "zod";
import type { SafeProfile } from "../../../packages/profile/src/build-profile.js";
import { evaluateJob, type JobMatchResult } from "../../../packages/matching/src/evaluate-job.js";
import { DatabaseService } from "./database.service.js";

const USER_KEY = "github:Kaedeeeeeeeeee";
const RANKING_VERSION = "deterministic-v1";

interface ProfileRow { profile_version_id: string; structured_profile: SafeProfile }
interface JobRow {
  canonical_job_id: string;
  canonical_job_version_id: string;
  lifecycle_state: "active" | "suspect" | "closed";
  title: string;
  application_url: string;
  structured_result: Record<string, unknown>;
  verified_official_source: boolean;
  company_name: string | null;
  source_kind: string;
  source_key: string;
  fetched_at: Date;
  source_health: string;
  saved: boolean;
  hidden: boolean;
  applied_at: Date | null;
}
interface EvidenceRow {
  field_path: string;
  evidence_id: string;
  quoted_text: string;
  source_url: string;
  locator: Record<string, unknown>;
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
    const profileResult = await this.database.query<ProfileRow>(`SELECT pv.id profile_version_id,pv.structured_profile
      FROM profiles p JOIN profile_versions pv ON pv.id=p.current_version_id WHERE p.profile_key='primary'`);
    const profileRow = profileResult.rows[0];
    if (profileRow === undefined) return { profileConfigured: false, jobs: [] };
    const jobs = await this.loadJobs();
    const output = [];
    for (const row of jobs) {
      const evidenceRows = await this.database.query<EvidenceRow>(`SELECT cfe.field_path,e.id evidence_id,e.quoted_text,e.source_url,e.locator
        FROM canonical_field_evidence cfe JOIN evidence e ON e.id=cfe.evidence_id
        WHERE cfe.canonical_job_version_id=$1 ORDER BY e.created_at`, [row.canonical_job_version_id]);
      const evidenceByField: Record<string, string[]> = {};
      for (const evidence of evidenceRows.rows) evidenceByField[evidence.field_path] = [...(evidenceByField[evidence.field_path] ?? []), evidence.evidence_id];
      const match = evaluateJob(profileRow.structured_profile, {
        canonicalJobId: row.canonical_job_id, canonicalJobVersionId: row.canonical_job_version_id,
        lifecycleState: row.lifecycle_state, verifiedOfficialSource: row.verified_official_source,
        title: row.title, applicationUrl: row.application_url, fetchedAt: row.fetched_at.toISOString(),
        structured: row.structured_result, evidenceByField,
      });
      output.push({
        title: row.title, companyName: row.company_name ?? row.source_key,
        applicationUrl: row.application_url, sourceKind: row.source_kind, sourceKey: row.source_key,
        fetchedAt: row.fetched_at.toISOString(), sourceHealth: row.source_health,
        state: { saved: row.saved, hidden: row.hidden, appliedAt: row.applied_at?.toISOString() ?? null },
        evidence: evidenceRows.rows.map((value) => ({
          id: value.evidence_id, field: value.field_path, quote: value.quoted_text,
          sourceUrl: value.source_url, locator: value.locator,
        })),
        ...match,
      });
    }
    output.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title, "ja"));
    const visible = output.filter((job) => this.inView(job, view));
    const recommendationRunId = await this.persistRun(profileRow.profile_version_id, output);
    return {
      profileConfigured: true, rankingVersion: RANKING_VERSION, recommendationRunId,
      generatedAt: new Date().toISOString(), total: output.length, visible: visible.length, jobs: visible,
    };
  }

  @Get("/profile")
  async profile() {
    const result = await this.database.query<ProfileRow>(`SELECT pv.id profile_version_id,pv.structured_profile
      FROM profiles p JOIN profile_versions pv ON pv.id=p.current_version_id WHERE p.profile_key='primary'`);
    return result.rows[0] ?? null;
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
    return { canonicalJobId, saved: state?.saved ?? false, hidden: state?.hidden ?? false, appliedAt: state?.applied_at?.toISOString() ?? null };
  }

  private async loadJobs(): Promise<JobRow[]> {
    const result = await this.database.query<JobRow>(`SELECT c.id canonical_job_id,v.id canonical_job_version_id,
      c.lifecycle_state,v.title,v.application_url,v.structured_result,source.fetched_at,source.source_kind,
      source.tenant_key source_key,source.health_state source_health,company.display_name company_name,
      COALESCE(state.saved,false) saved,COALESCE(state.hidden,false) hidden,state.applied_at,
      EXISTS(SELECT 1 FROM canonical_job_sources verified_cjs
        JOIN source_job_records verified_record ON verified_record.id=verified_cjs.source_job_record_id
        JOIN source_instances verified_source ON verified_source.id=verified_record.source_instance_id
        JOIN company_source_relationships csr ON csr.source_instance_id=verified_source.id
        WHERE verified_cjs.canonical_job_id=c.id AND verified_cjs.active_to IS NULL
          AND verified_source.verification_state='verified' AND csr.verification_state='verified' AND csr.valid_to IS NULL
      ) verified_official_source
      FROM canonical_jobs c JOIN canonical_job_versions v ON v.id=c.current_version_id
      JOIN LATERAL (SELECT si.source_kind,si.tenant_key,si.health_state,sv.fetched_at,sjr.source_instance_id
        FROM canonical_job_sources cjs JOIN source_job_records sjr ON sjr.id=cjs.source_job_record_id
        JOIN source_instances si ON si.id=sjr.source_instance_id
        JOIN source_job_versions sv ON sv.source_job_record_id=sjr.id
        WHERE cjs.canonical_job_id=c.id AND cjs.source_role='primary' AND cjs.active_to IS NULL
        ORDER BY sv.fetched_at DESC LIMIT 1) source ON true
      LEFT JOIN LATERAL (SELECT co.display_name FROM company_source_relationships csr JOIN companies co ON co.id=csr.company_id
        WHERE csr.source_instance_id=source.source_instance_id AND csr.verification_state='verified' AND csr.valid_to IS NULL
        ORDER BY csr.valid_from DESC LIMIT 1) company ON true
      LEFT JOIN job_user_states state ON state.canonical_job_id=c.id AND state.user_key=$1`, [USER_KEY]);
    return result.rows;
  }

  private inView(job: { eligible: boolean; state: { saved: boolean; hidden: boolean; appliedAt: string | null } }, view: string): boolean {
    if (view === "saved") return job.state.saved && !job.state.hidden;
    if (view === "applied") return job.state.appliedAt !== null && !job.state.hidden;
    if (view === "hidden") return job.state.hidden;
    return job.eligible && !job.state.hidden;
  }

  private async persistRun(profileVersionId: string, jobs: Array<JobMatchResult & { title: string }>): Promise<string> {
    const runKey = createHash("sha256").update(JSON.stringify({
      rankingVersion: RANKING_VERSION, profileVersionId,
      inputs: jobs.map((job) => [job.canonicalJobVersionId, job.score]),
    })).digest("hex");
    const runId = randomUUID();
    return this.database.transaction(async (query) => {
      const inserted = await query<{ id: string }>(`INSERT INTO recommendation_runs(
          id,user_key,run_key,profile_version_id,ranking_version,eligible_count,input_count
        ) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_key,run_key) DO NOTHING RETURNING id`, [
        runId, USER_KEY, runKey, profileVersionId, RANKING_VERSION, jobs.filter((job) => job.eligible).length, jobs.length,
      ]);
      const id = inserted.rows[0]?.id ?? (await query<{ id: string }>(
        "SELECT id FROM recommendation_runs WHERE user_key=$1 AND run_key=$2", [USER_KEY, runKey])).rows[0]?.id;
      if (id === undefined) throw new Error("Recommendation run disappeared");
      if (inserted.rows[0] !== undefined) {
        for (const [index, job] of jobs.entries()) {
          await query(`INSERT INTO recommendation_results(recommendation_run_id,canonical_job_id,canonical_job_version_id,
            rank,score,eligible,score_breakdown,explanation) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`, [
            id, job.canonicalJobId, job.canonicalJobVersionId, index + 1, job.score, job.eligible,
            JSON.stringify(job.scoreBreakdown), JSON.stringify({ matched: job.matched, gaps: job.gaps, unknowns: job.unknowns }),
          ]);
        }
      }
      return id;
    });
  }
}
