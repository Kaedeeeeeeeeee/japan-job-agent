import { Controller, Get, Inject } from "@nestjs/common";
import type { SafeProfile } from "../../../packages/profile/src/build-profile.js";
import { evaluateJob } from "../../../packages/matching/src/evaluate-job.js";
import { DatabaseService } from "./database.service.js";

interface JobRow {
  canonical_job_id: string;
  canonical_job_version_id: string;
  lifecycle_state: "active" | "suspect" | "closed";
  title: string;
  application_url: string;
  structured_result: Record<string, unknown>;
  verified_official_source: boolean;
}

@Controller("/agent")
export class AgentController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Get("/jobs")
  async jobs() {
    const profileResult = await this.database.query<{ structured_profile: SafeProfile }>(`SELECT pv.structured_profile
      FROM profiles p JOIN profile_versions pv ON pv.id=p.current_version_id WHERE p.profile_key='primary'`);
    const profile = profileResult.rows[0]?.structured_profile;
    if (profile === undefined) return { profileConfigured: false, jobs: [] };
    const jobs = await this.database.query<JobRow>(`SELECT c.id canonical_job_id,v.id canonical_job_version_id,
      c.lifecycle_state,v.title,v.application_url,v.structured_result,EXISTS(
        SELECT 1 FROM canonical_job_sources cjs JOIN source_job_records r ON r.id=cjs.source_job_record_id
        JOIN source_instances s ON s.id=r.source_instance_id
        JOIN company_source_relationships csr ON csr.source_instance_id=s.id
        WHERE cjs.canonical_job_id=c.id AND cjs.active_to IS NULL AND s.verification_state='verified'
        AND csr.verification_state='verified' AND csr.valid_to IS NULL
      ) verified_official_source FROM canonical_jobs c JOIN canonical_job_versions v ON v.id=c.current_version_id`);
    const output = [];
    for (const row of jobs.rows) {
      const evidenceRows = await this.database.query<{ field_path: string; evidence_id: string }>(`SELECT field_path,evidence_id
        FROM canonical_field_evidence WHERE canonical_job_version_id=$1`, [row.canonical_job_version_id]);
      const evidenceByField: Record<string, string[]> = {};
      for (const evidence of evidenceRows.rows) evidenceByField[evidence.field_path] = [...(evidenceByField[evidence.field_path] ?? []), evidence.evidence_id];
      const match = evaluateJob(profile, {
        canonicalJobId: row.canonical_job_id, canonicalJobVersionId: row.canonical_job_version_id,
        lifecycleState: row.lifecycle_state, verifiedOfficialSource: row.verified_official_source,
        title: row.title, applicationUrl: row.application_url, structured: row.structured_result, evidenceByField,
      });
      output.push({ title: row.title, applicationUrl: row.application_url, ...match });
    }
    return { profileConfigured: true, jobs: output };
  }
}

