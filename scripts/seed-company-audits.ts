import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import pg from "pg";

interface Seed {
  key: string; name: string; pool: "direct" | "watch"; officialDomain: string;
  auditState: "discovery" | "verified" | "no_current_job" | "blocked";
  sourceKind?: "greenhouse" | "schema_org" | "manual"; tenantKey?: string; sourceUrl?: string;
  currentJobCount?: number; evidenceQuote?: string; notes?: string;
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
const seeds = JSON.parse(await fs.readFile(path.resolve("config/company-seeds.json"), "utf8")) as Seed[];
const { Client } = pg;
const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  for (const seed of seeds) await client.query("BEGIN").then(async () => {
    try { await upsertSeed(seed); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK"); throw error; }
  });
  const result = await client.query<{ total: string; verified: string }>(`SELECT count(*)::text total,
    count(*) FILTER (WHERE audit_state='verified')::text verified FROM company_seed_audits`);
  process.stdout.write(`${JSON.stringify(result.rows[0])}\n`);
} finally { await client.end(); }

async function upsertSeed(seed: Seed): Promise<void> {
  let companyId: string | null = null;
  let sourceInstanceId: string | null = null;
  if (seed.auditState === "verified") {
    if (seed.sourceKind === undefined || seed.tenantKey === undefined || seed.sourceUrl === undefined || seed.evidenceQuote === undefined) {
      throw new Error(`Verified seed ${seed.key} is missing source evidence`);
    }
    const company = await client.query<{ id: string }>("SELECT id FROM companies WHERE legal_name=$1 ORDER BY created_at LIMIT 1", [seed.name]);
    companyId = company.rows[0]?.id ?? randomUUID();
    if (company.rows[0] === undefined) await client.query(`INSERT INTO companies(id,legal_name,display_name,verification_state)
      VALUES($1,$2,$2,'verified')`, [companyId, seed.name]);
    else await client.query("UPDATE companies SET verification_state='verified',updated_at=now() WHERE id=$1", [companyId]);
    await client.query(`INSERT INTO company_domains(company_id,domain,is_official,verified_at,verification_note)
      VALUES($1,$2,true,now(),'Seed audit verified official recruiting page')
      ON CONFLICT(company_id,domain) DO UPDATE SET is_official=true,verified_at=now(),verification_note=excluded.verification_note`, [companyId, seed.officialDomain]);
    const source = await client.query<{ id: string }>(`INSERT INTO source_instances(source_kind,tenant_key,base_url,verification_state)
      VALUES($1,$2,$3,'verified') ON CONFLICT(source_kind,tenant_key) DO UPDATE SET verification_state='verified',updated_at=now() RETURNING id`,
    [seed.sourceKind, seed.tenantKey, new URL(seed.sourceUrl).origin]);
    sourceInstanceId = source.rows[0]?.id ?? null;
    if (sourceInstanceId === null) throw new Error(`Could not seed source ${seed.key}`);
    const relationship = await client.query<{ id: string }>(`SELECT id FROM company_source_relationships WHERE company_id=$1
      AND source_instance_id=$2 AND relationship_kind='official_owner' AND valid_to IS NULL`, [companyId, sourceInstanceId]);
    const relationshipId = relationship.rows[0]?.id ?? randomUUID();
    if (relationship.rows[0] === undefined) await client.query(`INSERT INTO company_source_relationships(id,company_id,source_instance_id,
      relationship_kind,valid_from,verification_state) VALUES($1,$2,$3,'official_owner',now(),'verified')`, [relationshipId, companyId, sourceInstanceId]);
    const evidence = await client.query("SELECT 1 FROM evidence WHERE company_source_relationship_id=$1 AND source_url=$2", [relationshipId, seed.sourceUrl]);
    if (evidence.rows[0] === undefined) await client.query(`INSERT INTO evidence(kind,company_source_relationship_id,field_path,quoted_text,source_url,locator)
      VALUES('ats_link',$1,'company_source_relationship',$2,$3,$4::jsonb)`, [relationshipId, seed.evidenceQuote, seed.sourceUrl,
      JSON.stringify({ audit: "company-seed-v1", checkedAt: new Date().toISOString() })]);
  }
  await client.query(`INSERT INTO company_seed_audits(seed_key,company_name,pool,audit_state,company_id,source_instance_id,
      official_domain,current_job_count,evidence_url,checked_at,notes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10)
    ON CONFLICT(seed_key) DO UPDATE SET company_name=excluded.company_name,pool=excluded.pool,audit_state=excluded.audit_state,
      company_id=excluded.company_id,source_instance_id=excluded.source_instance_id,official_domain=excluded.official_domain,
      current_job_count=excluded.current_job_count,evidence_url=excluded.evidence_url,checked_at=excluded.checked_at,
      notes=excluded.notes,updated_at=now()`, [seed.key, seed.name, seed.pool, seed.auditState, companyId, sourceInstanceId,
    seed.officialDomain, seed.currentJobCount ?? null, seed.sourceUrl ?? null, seed.notes ?? null]);
}
