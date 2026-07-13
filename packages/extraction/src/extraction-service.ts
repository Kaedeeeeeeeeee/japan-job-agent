import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { JobParser, ParserContext, SourceJobVersion } from "../../contracts/src/index.js";
import type { OutboxDatabase } from "../../db/src/outbox.js";
import type { ParsedJob } from "../../parser/src/deterministic-job-parser.js";
import type { RawObjectStore } from "../../storage/src/object-store.js";

interface RawRow {
  id: string;
  source_job_record_id: string;
  raw_hash: string;
  content_hash: string;
  canonicalization_version: string;
  raw_storage_key: string;
  source_url: string;
  fetched_at: Date;
  source_instance_id: string;
  source_kind: ParserContext["source"]["sourceKind"];
  tenant_key: string;
  base_url: string;
}

export interface ExtractionRunResult {
  extractionId: string;
  status: "pending" | "succeeded" | "failed";
  reused: boolean;
  evidenceCount: number;
}

export class ExtractionService {
  constructor(
    private readonly db: Kysely<OutboxDatabase>,
    private readonly objectStore: RawObjectStore,
  ) {}

  async extract(sourceJobVersionId: string, parser: JobParser): Promise<ExtractionRunResult> {
    const rawResult = await sql<RawRow>`SELECT v.id, v.source_job_record_id, v.raw_hash, v.content_hash,
      v.canonicalization_version, v.raw_storage_key, v.source_url, v.fetched_at,
      s.id AS source_instance_id, s.source_kind, s.tenant_key, s.base_url
      FROM source_job_versions v
      JOIN source_job_records r ON r.id = v.source_job_record_id
      JOIN source_instances s ON s.id = r.source_instance_id
      WHERE v.id = ${sourceJobVersionId}::uuid`.execute(this.db);
    const row = rawResult.rows[0];
    if (row === undefined) throw new Error(`Raw version ${sourceJobVersionId} does not exist`);
    const raw = await this.objectStore.get(row.raw_storage_key);
    const extractionId = randomUUID();
    const inserted = await sql<{ id: string }>`INSERT INTO source_job_extractions(
        id, source_job_version_id, parser_key, parser_version, schema_version, status
      ) VALUES (${extractionId}::uuid, ${sourceJobVersionId}::uuid, ${parser.parserKey}, ${parser.parserVersion}, ${parser.schemaVersion}, 'pending')
      ON CONFLICT (source_job_version_id, parser_key, parser_version, schema_version) DO NOTHING
      RETURNING id`.execute(this.db);
    if (inserted.rows[0] === undefined) {
      const existing = await sql<{ id: string; status: ExtractionRunResult["status"] }>`SELECT id, status FROM source_job_extractions
        WHERE source_job_version_id = ${sourceJobVersionId}::uuid AND parser_key = ${parser.parserKey}
        AND parser_version = ${parser.parserVersion} AND schema_version = ${parser.schemaVersion}`.execute(this.db);
      const found = existing.rows[0];
      if (found === undefined) throw new Error("Idempotent extraction disappeared");
      return { extractionId: found.id, status: found.status, reused: true, evidenceCount: 0 };
    }

    const version: SourceJobVersion = {
      id: row.id,
      sourceJobRecordId: row.source_job_record_id,
      rawHash: row.raw_hash,
      contentHash: row.content_hash,
      canonicalizationVersion: row.canonicalization_version,
      raw,
      sourceUrl: row.source_url,
      fetchedAt: row.fetched_at.toISOString(),
    };
    const context: ParserContext = {
      source: { id: row.source_instance_id, sourceKind: row.source_kind, tenantKey: row.tenant_key, baseUrl: row.base_url },
      localeHints: ["ja-JP", "en"],
    };
    const candidate = await parser.parse(version, context);
    const extractionHash = createHash("sha256").update(stableJson(candidate.structured)).digest("hex");
    if (candidate.status === "failed") {
      await sql`UPDATE source_job_extractions SET status = 'failed', structured_result = ${JSON.stringify(candidate.structured)}::jsonb,
        extraction_hash = ${extractionHash}, errors = ${JSON.stringify(candidate.errors)}::jsonb, completed_at = now()
        WHERE id = ${extractionId}::uuid`.execute(this.db);
      return { extractionId, status: "failed", reused: false, evidenceCount: 0 };
    }
    await this.persistSuccessful(extractionId, candidate.structured as ParsedJob, candidate.evidence, extractionHash);
    return { extractionId, status: "succeeded", reused: false, evidenceCount: candidate.evidence.length };
  }

  private async persistSuccessful(
    extractionId: string,
    job: ParsedJob,
    candidates: Awaited<ReturnType<JobParser["parse"]>>["evidence"],
    extractionHash: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`UPDATE source_job_extractions SET status = 'succeeded', structured_result = ${JSON.stringify(job)}::jsonb,
        extraction_hash = ${extractionHash}, errors = '[]'::jsonb, completed_at = now()
        WHERE id = ${extractionId}::uuid`.execute(trx);
      const evidenceByField = new Map<string, string[]>();
      for (const candidate of candidates) {
        const evidenceId = randomUUID();
        await sql`INSERT INTO evidence(id, kind, source_job_extraction_id, field_path, quoted_text, source_url, locator)
          VALUES (${evidenceId}::uuid, 'field_quote', ${extractionId}::uuid, ${candidate.fieldPath}, ${candidate.quotedText},
          ${candidate.sourceUrl}, ${JSON.stringify(candidate.locator)}::jsonb)`.execute(trx);
        evidenceByField.set(candidate.fieldPath, [...(evidenceByField.get(candidate.fieldPath) ?? []), evidenceId]);
      }
      const facts = [
        ["employment_types", job.employmentTypes.state], ["visa_sponsorship", job.visaSupport.state],
        ["locations", job.locations.state], ["languages", job.languages.state],
        ["skills", job.skills.state], ["compensation", job.compensation.state],
      ] as const;
      for (const [field, state] of facts) {
        await sql`INSERT INTO extraction_field_states(extraction_id, field_name, value_state)
          VALUES (${extractionId}::uuid, ${field}, ${state}::explicit_value_state)`.execute(trx);
      }
      await insertEmployment(trx, extractionId, job, evidenceByField.get("employmentTypes") ?? []);
      await insertLocations(trx, extractionId, job, evidenceByField.get("locations") ?? []);
      await insertLanguages(trx, extractionId, job, evidenceByField.get("languages") ?? []);
      await insertSkills(trx, extractionId, job, evidenceByField.get("skills") ?? []);
      await insertCompensation(trx, extractionId, job, evidenceByField.get("compensation") ?? []);
      const visaValues = job.visaSupport.values;
      await sql`INSERT INTO extraction_mobility_facts(
          extraction_id, visa_transfer_state, relocation_support_state, relocation_required_state, transfer_required_state,
          visa_sponsorship_state, visa_sponsorship
        ) VALUES (${extractionId}::uuid, 'unknown', 'unknown', 'unknown', 'unknown', ${job.visaSupport.state}::explicit_value_state,
          ${job.visaSupport.state === "known" ? visaValues[0] ?? null : null})`.execute(trx);
      await sql`INSERT INTO outbox_events(aggregate_type, aggregate_id, event_type, payload, dedup_key)
        VALUES ('source_job_extraction', ${extractionId}::uuid, 'source_job.extraction_completed',
        ${JSON.stringify({ extractionId })}::jsonb, ${`extraction-completed:${extractionId}`})`.execute(trx);
    });
  }
}

type Trx = Transaction<OutboxDatabase>;

async function insertEmployment(trx: Trx, id: string, job: ParsedJob, evidence: string[]): Promise<void> {
  for (const [index, value] of job.employmentTypes.values.entries()) {
    await sql`INSERT INTO extraction_employment_types(extraction_id, employment_type, evidence_id)
      VALUES (${id}::uuid, ${value}, ${requiredEvidence(evidence, index, "employmentTypes")}::uuid)`.execute(trx);
  }
}

async function insertLocations(trx: Trx, id: string, job: ParsedJob, evidence: string[]): Promise<void> {
  for (const [index, value] of job.locations.values.entries()) {
    await sql`INSERT INTO extraction_locations(extraction_id, country_code, prefecture, city, address_text, remote_scope, evidence_id)
      VALUES (${id}::uuid, ${value.countryCode}, ${value.prefecture}, ${value.city}, ${value.addressText}, ${value.remoteScope},
      ${requiredEvidence(evidence, index, "locations")}::uuid)`.execute(trx);
  }
}

async function insertLanguages(trx: Trx, id: string, job: ParsedJob, evidence: string[]): Promise<void> {
  for (const [index, value] of job.languages.values.entries()) {
    await sql`INSERT INTO extraction_languages(extraction_id, language_code, minimum_level, requirement_kind, evidence_id)
      VALUES (${id}::uuid, ${value.languageCode}, ${value.minimumLevel}, ${value.requirementKind},
      ${requiredEvidence(evidence, index, "languages")}::uuid)`.execute(trx);
  }
}

async function insertSkills(trx: Trx, id: string, job: ParsedJob, evidence: string[]): Promise<void> {
  for (const [index, value] of job.skills.values.entries()) {
    await sql`INSERT INTO extraction_skills(extraction_id, normalized_skill, original_text, requirement_kind, evidence_id)
      VALUES (${id}::uuid, ${value.normalizedSkill}, ${value.originalText}, ${value.requirementKind},
      ${requiredEvidence(evidence, index, "skills")}::uuid)`.execute(trx);
  }
}

async function insertCompensation(trx: Trx, id: string, job: ParsedJob, evidence: string[]): Promise<void> {
  for (const [index, value] of job.compensation.values.entries()) {
    await sql`INSERT INTO extraction_compensation(extraction_id, compensation_kind, currency, period, minimum_amount,
      maximum_amount, is_calculated, evidence_id) VALUES (${id}::uuid, ${value.compensationKind}, ${value.currency}, ${value.period},
      ${value.minimumAmount}, ${value.maximumAmount}, ${value.isCalculated}, ${requiredEvidence(evidence, index, "compensation")}::uuid)`.execute(trx);
  }
}

function requiredEvidence(evidence: string[], index: number, field: string): string {
  const id = evidence[index] ?? evidence[0];
  if (id === undefined) throw new Error(`Non-unknown ${field} value has no evidence`);
  return id;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
