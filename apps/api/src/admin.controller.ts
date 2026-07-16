import { BadRequestException, Body, ConflictException, Controller, Get, Header, Inject, NotFoundException, Param, Post, Put, Query } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sourceKindSchema } from "../../../packages/contracts/src/index.js";
import { DatabaseService } from "./database.service.js";
import type { AiFactCandidate, EnrichableJobField } from "../../../packages/contracts/src/index.js";
import type { ParsedJob } from "../../../packages/parser/src/deterministic-job-parser.js";
import { validateFactCandidates } from "../../../packages/ai/src/job-local-rag.js";
import { mergeAiCandidates } from "../../../packages/ai/src/hybrid-extraction.js";
import { ExtractionService } from "../../../packages/extraction/src/extraction-service.js";
import { CanonicalService } from "../../../packages/canonical/src/canonical-service.js";

const companyInput = z.object({
  legalName: z.string().min(1),
  displayName: z.string().min(1),
  corporateNumber: z.string().min(1).optional(),
  officialDomain: z.string().min(1),
});
const sourceInput = z.object({
  sourceKind: sourceKindSchema,
  tenantKey: z.string().min(1),
  baseUrl: z.url(),
});
const relationshipInput = z.object({
  companyId: z.string().uuid(),
  sourceInstanceId: z.string().uuid(),
  relationshipKind: z.enum(["official_owner", "official_recruiting_for", "historical_owner"]),
  evidence: z.object({ quotedText: z.string().min(1), sourceUrl: z.url(), locator: z.record(z.string(), z.unknown()) }),
});
const policyInput = z.object({
  requiresJavascript: z.boolean().default(false),
  requiresCookies: z.boolean().default(false),
  allowsAuthoritativeSnapshot: z.boolean(),
  minimumMissingIntervalHours: z.number().positive().default(12),
  ownerContact: z.string().nullable().default(null),
  termsUrl: z.url().nullable().default(null),
  policyNotes: z.string().nullable().default(null),
});
const fieldReviewResolveInput = z.object({
  sectionId: z.string().uuid(),
  quote: z.string().min(1),
  rawValue: z.string().min(1),
  normalizedCandidate: z.unknown(),
  requirementKind: z.enum(["required", "preferred", "mentioned"]).default("mentioned"),
});

@Controller("/admin")
export class AdminController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Post("/companies")
  async createCompany(@Body() body: unknown) {
    const input = companyInput.parse(body);
    const companyId = randomUUID();
    const domainId = randomUUID();
    await this.database.transaction(async (query) => {
      await query(`INSERT INTO companies(id, legal_name, display_name, corporate_number)
        VALUES ($1, $2, $3, $4)`, [companyId, input.legalName, input.displayName, input.corporateNumber ?? null]);
      await query(`INSERT INTO company_domains(id, company_id, domain, is_official)
        VALUES ($1, $2, $3, false)`, [domainId, companyId, input.officialDomain]);
    });
    return { companyId, domainId, verificationState: "discovery" };
  }

  @Post("/sources")
  async createSource(@Body() body: unknown) {
    const input = sourceInput.parse(body);
    const sourceInstanceId = randomUUID();
    await this.database.query(`INSERT INTO source_instances(id, source_kind, tenant_key, base_url)
      VALUES ($1, $2, $3, $4)`, [sourceInstanceId, input.sourceKind, input.tenantKey, input.baseUrl]);
    return { sourceInstanceId, verificationState: "discovery" };
  }

  @Post("/relationships")
  async createRelationship(@Body() body: unknown) {
    const input = relationshipInput.parse(body);
    const relationshipId = randomUUID();
    const evidenceId = randomUUID();
    await this.database.transaction(async (query) => {
      await query(`INSERT INTO company_source_relationships(
          id, company_id, source_instance_id, relationship_kind, valid_from, verification_state
        ) VALUES ($1, $2, $3, $4, now(), 'verified')`, [
        relationshipId, input.companyId, input.sourceInstanceId, input.relationshipKind,
      ]);
      await query(`INSERT INTO evidence(
          id, kind, company_source_relationship_id, field_path, quoted_text, source_url, locator
        ) VALUES ($1, 'ats_link', $2, 'company_source_relationship', $3, $4, $5::jsonb)`, [
        evidenceId, relationshipId, input.evidence.quotedText, input.evidence.sourceUrl,
        JSON.stringify(input.evidence.locator),
      ]);
      await query("UPDATE source_instances SET verification_state = 'verified', updated_at = now() WHERE id = $1", [input.sourceInstanceId]);
      await query("UPDATE companies SET verification_state = 'verified', updated_at = now() WHERE id = $1", [input.companyId]);
      await query("UPDATE company_domains SET is_official = true, verified_at = now() WHERE company_id = $1", [input.companyId]);
    });
    return { relationshipId, evidenceId, verificationState: "verified" };
  }

  @Put("/sources/:id/policy")
  async upsertPolicy(@Param("id") sourceInstanceId: string, @Body() body: unknown) {
    const id = z.string().uuid().parse(sourceInstanceId);
    const input = policyInput.parse(body);
    await this.database.query(`INSERT INTO source_policies(
        source_instance_id, requires_javascript, requires_cookies, allows_authoritative_snapshot,
        minimum_missing_interval, owner_contact, terms_url, policy_notes
      ) VALUES ($1, $2, $3, $4, make_interval(hours => $5), $6, $7, $8)
      ON CONFLICT (source_instance_id) DO UPDATE SET
        requires_javascript = EXCLUDED.requires_javascript,
        requires_cookies = EXCLUDED.requires_cookies,
        allows_authoritative_snapshot = EXCLUDED.allows_authoritative_snapshot,
        minimum_missing_interval = EXCLUDED.minimum_missing_interval,
        owner_contact = EXCLUDED.owner_contact,
        terms_url = EXCLUDED.terms_url,
        policy_notes = EXCLUDED.policy_notes,
        updated_at = now()`, [
      id, input.requiresJavascript, input.requiresCookies, input.allowsAuthoritativeSnapshot,
      input.minimumMissingIntervalHours, input.ownerContact, input.termsUrl, input.policyNotes,
    ]);
    return { sourceInstanceId: id, updated: true };
  }

  @Get("/sources")
  async sources() {
    const result = await this.database.query(`SELECT s.*, r.status AS last_sync_status,
      r.snapshot_kind AS last_snapshot_kind, r.finished_at AS last_sync_at
      FROM source_instances s
      LEFT JOIN LATERAL (
        SELECT status, snapshot_kind, finished_at FROM source_sync_runs
        WHERE source_instance_id = s.id ORDER BY started_at DESC LIMIT 1
      ) r ON true ORDER BY s.tenant_key`);
    return result.rows;
  }

  @Get("/relationships/:id/evidence")
  async relationshipEvidence(@Param("id") relationshipId: string) {
    const id = z.string().uuid().parse(relationshipId);
    return (await this.database.query("SELECT * FROM evidence WHERE company_source_relationship_id = $1 ORDER BY created_at", [id])).rows;
  }

  @Get("/review-tasks")
  async reviewTasks() {
    return (await this.database.query(`SELECT * FROM (
      SELECT t.id,'source_sync' task_kind,t.reason,t.detail,t.state,t.created_at,s.tenant_key,s.source_kind,
        NULL::text field_name,NULL::uuid source_job_version_id
      FROM manual_review_tasks t LEFT JOIN source_instances s ON s.id=t.source_instance_id
      UNION ALL
      SELECT review.id,'job_field' task_kind,review.reason::text,
        jsonb_build_object('candidateQuotes',review.candidate_quotes,'promptVersion',review.prompt_version,
          'modelKey',review.model_key) detail,
        review.state,review.created_at,source.tenant_key,source.source_kind,review.field_name,review.source_job_version_id
      FROM field_review_tasks review
      JOIN source_job_versions version ON version.id=review.source_job_version_id
      JOIN source_job_records record ON record.id=version.source_job_record_id
      JOIN source_instances source ON source.id=record.source_instance_id
    ) tasks ORDER BY (state='open') DESC,created_at DESC`)).rows;
  }

  @Get("/field-review-tasks/:id")
  async fieldReviewTask(@Param("id") rawTaskId: string) {
    const taskId = z.string().uuid().parse(rawTaskId);
    const task = await this.database.query<Record<string, unknown>>(`SELECT review.*,version.source_url,
      document.id canonical_document_id,document.title
      FROM field_review_tasks review
      JOIN source_job_versions version ON version.id=review.source_job_version_id
      LEFT JOIN LATERAL (
        SELECT id,title FROM canonical_documents WHERE source_job_version_id=version.id
        ORDER BY created_at DESC,id DESC LIMIT 1
      ) document ON true WHERE review.id=$1`, [taskId]);
    const row = task.rows[0];
    if (row === undefined) throw new NotFoundException("Field Review Task does not exist");
    const sections = row.canonical_document_id === null || row.canonical_document_id === undefined ? []
      : (await this.database.query(`SELECT id,section_kind,heading,ordinal,section_text,locator
          FROM canonical_document_sections WHERE canonical_document_id=$1 ORDER BY ordinal`, [row.canonical_document_id])).rows;
    return { task: row, sections };
  }

  @Post("/field-review-tasks/:id/resolve")
  async resolveFieldReviewTask(@Param("id") rawTaskId: string, @Body() body: unknown) {
    const taskId = z.string().uuid().parse(rawTaskId);
    const input = fieldReviewResolveInput.parse(body);
    const task = await this.database.query<{
      id: string;
      state: "open" | "resolved" | "dismissed";
      field_name: EnrichableJobField;
      source_job_version_id: string;
      source_url: string;
      extraction_id: string;
      head_extraction_id: string;
      head_source_job_version_id: string;
      structured_result: ParsedJob;
    }>(`SELECT review.id,review.state,review.field_name,review.source_job_version_id,version.source_url,
      review.extraction_id,head.extraction_id head_extraction_id,head.source_job_version_id head_source_job_version_id,
      extraction.structured_result
      FROM field_review_tasks review
      JOIN source_job_versions version ON version.id=review.source_job_version_id
      JOIN source_job_extraction_heads head ON head.source_job_record_id=version.source_job_record_id
      JOIN source_job_extractions extraction ON extraction.id=head.extraction_id
      WHERE review.id=$1`, [taskId]);
    const row = task.rows[0];
    if (row === undefined) throw new NotFoundException("Field Review Task does not exist");
    if (row.state !== "open") throw new ConflictException("Field Review Task is already closed");
    if (row.head_source_job_version_id !== row.source_job_version_id) {
      throw new ConflictException("A newer Raw Version exists; resolve its review task instead");
    }
    const section = await this.database.query<{ id: string; section_kind: string; heading: string | null; section_text: string }>(`
      SELECT section.id,section.section_kind,section.heading,section.section_text
      FROM canonical_document_sections section JOIN canonical_documents document ON document.id=section.canonical_document_id
      WHERE section.id=$1 AND document.source_job_version_id=$2`, [input.sectionId, row.source_job_version_id]);
    const sourceSection = section.rows[0];
    if (sourceSection === undefined) throw new BadRequestException("Section does not belong to the reviewed Raw Version");
    const candidate: AiFactCandidate = { field: row.field_name, quote: input.quote, sectionId: input.sectionId,
      rawValue: input.rawValue, normalizedCandidate: input.normalizedCandidate, requirementKind: input.requirementKind };
    validateFactCandidates([candidate], [{ id: sourceSection.id, kind: sourceSection.section_kind,
      heading: sourceSection.heading, text: sourceSection.section_text }], [row.field_name]);
    const merged = mergeAiCandidates(row.structured_result, [candidate], row.source_url,
      `manual-review:${taskId}`, "manual");
    if (merged.changedFields.length === 0) throw new BadRequestException("Selected quote could not be normalized or the field is no longer unknown");
    const evidence = merged.evidence.map((item) => ({ ...item,
      locator: { ...item.locator, kind: "manual_review", reviewTaskId: taskId } }));
    const derived = await new ExtractionService(this.database.kysely).persistDerived({
      sourceJobVersionId: row.source_job_version_id,
      parentExtractionId: row.head_extraction_id,
      origin: "manual",
      parserKey: "manual-review",
      parserVersion: `manual-v1:${taskId}`,
      schemaVersion: "job-v3",
      structured: merged.structured,
      evidence,
    });
    const canonical = await new CanonicalService(this.database.kysely, { enrichmentEnabled: false }).materialize(derived.extractionId);
    await this.database.query(`UPDATE field_review_tasks SET state='resolved',resolution_extraction_id=$2,
      resolved_at=now() WHERE id=$1 AND state='open'`, [taskId, derived.extractionId]);
    return { taskId, resolutionExtractionId: derived.extractionId,
      canonicalJobVersionId: canonical.canonicalJobVersionId, readinessUpdated: true };
  }

  @Get("/seed-audits")
  async seedAudits() {
    return (await this.database.query("SELECT * FROM company_seed_audits ORDER BY pool,company_name")).rows;
  }

  @Get("/discovery/jobs/summary")
  async discoveryJobSummary() {
    const result = await this.database.query(`SELECT
      count(*)::int total,
      count(*) FILTER (WHERE location_state='japan' AND state NOT IN ('rejected','expired') AND (
        (origin_kind='official_collection' AND last_authoritative_import_run_id IS NOT NULL
          AND last_authoritative_seen_at>=now()-interval '72 hours')
        OR (origin_kind<>'official_collection' AND observation_count>=2 AND last_seen_at>=now()-interval '30 days')
      ))::int valid,
      count(*) FILTER (WHERE state='discovered')::int discovered,
      count(*) FILTER (WHERE state='resolving')::int resolving,
      count(*) FILTER (WHERE state='resolved')::int resolved,
      count(*) FILTER (WHERE state='promoted')::int promoted,
      count(*) FILTER (WHERE state='rejected')::int rejected,
      count(*) FILTER (WHERE state='expired')::int expired,
      count(*) FILTER (WHERE location_state='japan')::int japan,
      count(*) FILTER (WHERE location_state='non_japan')::int non_japan,
      count(*) FILTER (WHERE location_state='unknown')::int unknown_location,
      count(*) FILTER (WHERE source_published_precision IS NOT NULL)::int published_known,
      count(*) FILTER (WHERE source_published_precision IS NULL)::int published_unknown,
      (SELECT count(*)::int FROM canonical_job_date_states dates
        JOIN canonical_jobs jobs ON jobs.current_version_id=dates.canonical_job_version_id AND jobs.lifecycle_state='active'
        WHERE dates.date_kind='published' AND dates.value_state='unknown') canonical_published_unknown,
      (SELECT count(*)::int FROM canonical_job_date_states dates
        JOIN canonical_jobs jobs ON jobs.current_version_id=dates.canonical_job_version_id AND jobs.lifecycle_state='active'
        WHERE dates.date_kind='published' AND dates.value_state='conflicting') canonical_published_conflicting,
      (SELECT count(*)::int FROM canonical_job_date_states dates
        JOIN canonical_jobs jobs ON jobs.current_version_id=dates.canonical_job_version_id AND jobs.lifecycle_state='active'
        WHERE dates.date_kind='source_updated' AND dates.value_state='unknown') canonical_updated_unknown,
      (SELECT count(*)::int FROM canonical_job_date_states dates
        JOIN canonical_jobs jobs ON jobs.current_version_id=dates.canonical_job_version_id AND jobs.lifecycle_state='active'
        WHERE dates.date_kind='source_updated' AND dates.value_state='conflicting') canonical_updated_conflicting,
      (SELECT count(*)::int FROM canonical_job_date_states dates
        JOIN canonical_jobs jobs ON jobs.current_version_id=dates.canonical_job_version_id AND jobs.lifecycle_state='active'
        WHERE dates.date_kind='valid_through' AND dates.value_state='unknown') canonical_deadline_unknown,
      (SELECT count(*)::int FROM canonical_job_date_states dates
        JOIN canonical_jobs jobs ON jobs.current_version_id=dates.canonical_job_version_id AND jobs.lifecycle_state='active'
        WHERE dates.date_kind='valid_through' AND dates.value_state='conflicting') canonical_deadline_conflicting
      FROM job_discovery_candidates`);
    return result.rows[0];
  }

  @Get("/discovery/jobs")
  async discoveryJobs(@Query("limit") rawLimit = "100", @Query("cursor") rawCursor?: string) {
    const limit = z.coerce.number().int().min(1).max(200).parse(rawLimit);
    const cursor = rawCursor === undefined ? null : decodeDiscoveryCursor(rawCursor);
    const result = await this.database.query<Record<string, unknown>>(`SELECT
      id,state,origin_kind,source_family,source_kind_hint,tenant_key,external_posting_id,
      detail_url,official_url,company_name,title,location_text,location_state,priority,
      observation_count,first_seen_at,last_seen_at,last_authoritative_seen_at,last_authoritative_import_run_id,
      source_published_date,source_published_at,source_published_precision,
      resolved_source_instance_id,promoted_source_job_record_id,rejection_reason
      FROM job_discovery_candidates
      WHERE ($1::timestamptz IS NULL OR (last_seen_at,id)<($1::timestamptz,$2::uuid))
      ORDER BY last_seen_at DESC,id DESC LIMIT $3`, [cursor?.lastSeenAt ?? null, cursor?.id ?? null, limit]);
    const last = result.rows.at(-1);
    return {
      candidates: result.rows,
      nextCursor: last === undefined ? null : encodeDiscoveryCursor(last.last_seen_at, String(last.id)),
    };
  }

  @Get("/discovery/jobs/:id")
  async discoveryJob(@Param("id") rawCandidateId: string) {
    const candidateId = z.string().uuid().parse(rawCandidateId);
    const [candidate, observations, attempts] = await Promise.all([
      this.database.query("SELECT * FROM job_discovery_candidates WHERE id=$1", [candidateId]),
      this.database.query(`SELECT id,observation_key,source_url,outbound_url,raw_company_name,raw_title,
        raw_location_text,raw_published_text,payload_hash,response_metadata,observed_at
        FROM job_discovery_observations WHERE candidate_id=$1 ORDER BY observed_at DESC,id DESC`, [candidateId]),
      this.database.query("SELECT * FROM job_promotion_attempts WHERE candidate_id=$1 ORDER BY created_at DESC,id DESC", [candidateId]),
    ]);
    return candidate.rows[0] === undefined ? null : {
      candidate: candidate.rows[0],
      observations: observations.rows,
      promotionAttempts: attempts.rows,
    };
  }

  @Get("/discovery/promotion-attempts")
  async discoveryPromotionAttempts(@Query("limit") rawLimit = "100") {
    const limit = z.coerce.number().int().min(1).max(200).parse(rawLimit);
    return (await this.database.query(`SELECT a.id,a.candidate_id,a.idempotency_key,a.state,a.available_at,
      a.lease_owner,a.lease_expires_at,a.attempt_count,a.failure_stage,a.last_error,a.created_at,a.completed_at,
      c.company_name,c.title,c.priority,c.source_family
      FROM job_promotion_attempts a JOIN job_discovery_candidates c ON c.id=a.candidate_id
      ORDER BY a.created_at DESC,a.id DESC LIMIT $1`, [limit])).rows;
  }

  @Get("/sync-runs/:id")
  async syncRun(@Param("id") syncRunId: string) {
    const id = z.string().uuid().parse(syncRunId);
    return (await this.database.query("SELECT * FROM source_sync_runs WHERE id = $1", [id])).rows[0] ?? null;
  }

  @Get("/review")
  @Header("content-type", "text/html; charset=utf-8")
  async reviewPage(): Promise<string> {
    const rows = await this.sources() as Array<Record<string, unknown>>;
    const body = rows.map((row) => `<tr>${["tenant_key", "source_kind", "verification_state", "health_state", "last_snapshot_kind", "last_sync_at"]
      .map((key) => `<td>${escapeHtml(String(row[key] ?? "—"))}</td>`).join("")}</tr>`).join("");
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Source Review</title>
      <style>body{font:14px system-ui;margin:32px;color:#172033}table{border-collapse:collapse;width:100%}th,td{padding:10px;border-bottom:1px solid #dce2ea;text-align:left}th{background:#f5f7fa}</style></head>
      <body><h1>Source Review</h1><table><thead><tr><th>Tenant</th><th>Kind</th><th>Verification</th><th>Health</th><th>Snapshot</th><th>Last sync</th></tr></thead><tbody>${body}</tbody></table></body></html>`;
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function encodeDiscoveryCursor(lastSeenAt: unknown, id: string): string {
  const date = lastSeenAt instanceof Date ? lastSeenAt : new Date(String(lastSeenAt));
  return Buffer.from(JSON.stringify({ lastSeenAt: date.toISOString(), id }), "utf8").toString("base64url");
}

function decodeDiscoveryCursor(value: string): { lastSeenAt: string; id: string } {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
  return {
    lastSeenAt: z.iso.datetime().parse(parsed.lastSeenAt),
    id: z.string().uuid().parse(parsed.id),
  };
}
