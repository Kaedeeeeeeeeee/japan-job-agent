import { Body, Controller, Get, Header, Inject, Param, Post, Put } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DatabaseService } from "./database.service.js";

const companyInput = z.object({
  legalName: z.string().min(1),
  displayName: z.string().min(1),
  corporateNumber: z.string().min(1).optional(),
  officialDomain: z.string().min(1),
});
const sourceInput = z.object({
  sourceKind: z.enum(["greenhouse", "schema_org", "manual", "hrmos"]),
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
    return (await this.database.query(`SELECT t.id,t.reason,t.detail,t.state,t.created_at,s.tenant_key,s.source_kind
      FROM manual_review_tasks t LEFT JOIN source_instances s ON s.id=t.source_instance_id
      ORDER BY (t.state='open') DESC,t.created_at DESC`)).rows;
  }

  @Get("/seed-audits")
  async seedAudits() {
    return (await this.database.query("SELECT * FROM company_seed_audits ORDER BY pool,company_name")).rows;
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
