import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import pg from "pg";

interface AuditResult {
  companyName: string;
  officialDomain: string;
  officialCareerUrl: string;
  tenantKey: string;
  boardUrl: string;
  auditedAt: string;
  officialLinkVerified: boolean;
  activeJobCount: number;
  japanJobCount: number;
  status: "verified" | "failed";
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
const auditPath = path.resolve("tmp/live-greenhouse-audit.json");
const audit = JSON.parse(await fs.readFile(auditPath, "utf8")) as AuditResult[];
const maximumAgeMs = 24 * 60 * 60 * 1_000;
for (const result of audit) {
  if (result.status !== "verified" || !result.officialLinkVerified || result.japanJobCount < 1) {
    throw new Error(`${result.tenantKey} does not have verified official and Japan-job evidence`);
  }
  if (Date.now() - new Date(result.auditedAt).getTime() > maximumAgeMs) {
    throw new Error(`${result.tenantKey} audit is older than 24 hours; run pnpm live:audit first`);
  }
}

const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl });
try {
  for (const seed of audit) await seedVerifiedSource(seed);
} finally {
  await pool.end();
}

async function seedVerifiedSource(seed: AuditResult): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existingCompany = await client.query<{ id: string }>("SELECT id FROM companies WHERE legal_name = $1 ORDER BY created_at LIMIT 1", [seed.companyName]);
    const companyId = existingCompany.rows[0]?.id ?? randomUUID();
    if (existingCompany.rows[0] === undefined) {
      await client.query(`INSERT INTO companies(id, legal_name, display_name, verification_state)
        VALUES ($1, $2, $2, 'verified')`, [companyId, seed.companyName]);
    } else {
      await client.query("UPDATE companies SET verification_state = 'verified', updated_at = now() WHERE id = $1", [companyId]);
    }
    await client.query(`INSERT INTO company_domains(company_id, domain, is_official, verified_at, verification_note)
      VALUES ($1, $2, true, $3, 'Official career page linked the configured Greenhouse board')
      ON CONFLICT (company_id, domain) DO UPDATE SET is_official = true, verified_at = EXCLUDED.verified_at,
      verification_note = EXCLUDED.verification_note`, [companyId, seed.officialDomain, seed.auditedAt]);

    const source = await client.query<{ id: string }>(`INSERT INTO source_instances(
        source_kind, tenant_key, base_url, verification_state, health_state
      ) VALUES ('greenhouse', $1, 'https://boards-api.greenhouse.io', 'verified', 'healthy')
      ON CONFLICT (source_kind, tenant_key) DO UPDATE SET verification_state = 'verified', updated_at = now()
      RETURNING id`, [seed.tenantKey]);
    const sourceInstanceId = source.rows[0]?.id;
    if (sourceInstanceId === undefined) throw new Error(`Failed to seed ${seed.tenantKey}`);
    await client.query(`INSERT INTO source_policies(
        source_instance_id, allows_authoritative_snapshot, terms_url, terms_reviewed_at, policy_notes
      ) VALUES ($1, true, $2, $3, $4)
      ON CONFLICT (source_instance_id) DO UPDATE SET allows_authoritative_snapshot = true,
        terms_url = EXCLUDED.terms_url, terms_reviewed_at = EXCLUDED.terms_reviewed_at,
        policy_notes = EXCLUDED.policy_notes, updated_at = now()`, [
      sourceInstanceId, seed.officialCareerUrl, seed.auditedAt,
      `Live audit: ${seed.activeJobCount} active, ${seed.japanJobCount} with Japan evidence`,
    ]);

    const existingRelationship = await client.query<{ id: string }>(`SELECT id FROM company_source_relationships
      WHERE company_id = $1 AND source_instance_id = $2 AND relationship_kind = 'official_owner' AND valid_to IS NULL`, [companyId, sourceInstanceId]);
    const relationshipId = existingRelationship.rows[0]?.id ?? randomUUID();
    if (existingRelationship.rows[0] === undefined) {
      await client.query(`INSERT INTO company_source_relationships(
        id, company_id, source_instance_id, relationship_kind, valid_from, verification_state
      ) VALUES ($1, $2, $3, 'official_owner', $4, 'verified')`, [relationshipId, companyId, sourceInstanceId, seed.auditedAt]);
    }
    const existingEvidence = await client.query("SELECT 1 FROM evidence WHERE company_source_relationship_id = $1 AND source_url = $2", [relationshipId, seed.officialCareerUrl]);
    if (existingEvidence.rows[0] === undefined) {
      await client.query(`INSERT INTO evidence(
          kind, company_source_relationship_id, field_path, quoted_text, source_url, locator
        ) VALUES ('ats_link', $1, 'company_source_relationship', $2, $3, $4::jsonb)`, [
        relationshipId, `${seed.companyName} official career page links ${seed.boardUrl}`,
        seed.officialCareerUrl, JSON.stringify({ href: seed.boardUrl, auditedAt: seed.auditedAt }),
      ]);
    }
    await client.query("COMMIT");
    process.stdout.write(`verified ${seed.tenantKey}: source=${sourceInstanceId} company=${companyId}\n`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

