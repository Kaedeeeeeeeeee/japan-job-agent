import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { OutboxDatabase } from "../../db/src/outbox.js";
import { normalizeApplicationUrl } from "./normalize-application-url.js";

interface InputRow {
  extraction_id: string;
  structured_result: Record<string, unknown>;
  source_job_record_id: string;
  source_instance_id: string;
  source_kind: "greenhouse" | "schema_org" | "manual";
  canonical_url: string;
  normalized_application_url: string | null;
  external_id: string | null;
}

interface ActiveInput {
  source_job_record_id: string;
  source_role: "primary" | "supporting";
  extraction_id: string;
  structured_result: Record<string, unknown>;
  canonical_url: string;
}

export interface MaterializationResult {
  canonicalJobId: string;
  canonicalJobVersionId: string;
  mergedBy: "existing_source" | "application_url" | "posting_id" | "official_link" | "new";
  versionCreated: boolean;
}

export class CanonicalService {
  constructor(private readonly db: Kysely<OutboxDatabase>) {}

  async materialize(
    extractionId: string,
    officialLink?: { canonicalJobId: string; evidenceId: string },
  ): Promise<MaterializationResult> {
    const input = await this.loadInput(extractionId);
    const normalizedUrl = normalizeApplicationUrl(input.canonical_url);
    await sql`UPDATE source_job_records SET normalized_application_url=${normalizedUrl}
      WHERE id=${input.source_job_record_id}::uuid`.execute(this.db);
    let mergedBy: MaterializationResult["mergedBy"] = "new";
    let canonicalJobId: string | undefined;
    const existing = await sql<{ canonical_job_id: string }>`SELECT canonical_job_id FROM canonical_job_sources
      WHERE source_job_record_id=${input.source_job_record_id}::uuid AND active_to IS NULL`.execute(this.db);
    if (existing.rows[0] !== undefined) {
      canonicalJobId = existing.rows[0].canonical_job_id;
      mergedBy = "existing_source";
    } else if (officialLink !== undefined) {
      canonicalJobId = officialLink.canonicalJobId;
      mergedBy = "official_link";
    } else {
      const urlMatch = await sql<{ canonical_job_id: string }>`SELECT cjs.canonical_job_id
        FROM canonical_job_sources cjs JOIN source_job_records r ON r.id=cjs.source_job_record_id
        WHERE cjs.active_to IS NULL AND r.normalized_application_url=${normalizedUrl}
        ORDER BY cjs.active_from LIMIT 1`.execute(this.db);
      if (urlMatch.rows[0] !== undefined) {
        canonicalJobId = urlMatch.rows[0].canonical_job_id;
        mergedBy = "application_url";
      } else if (input.external_id !== null) {
        const postingMatch = await sql<{ canonical_job_id: string }>`SELECT cjs.canonical_job_id
          FROM canonical_job_sources cjs
          JOIN source_job_records other ON other.id=cjs.source_job_record_id
          JOIN company_source_relationships mine ON mine.source_instance_id=${input.source_instance_id}::uuid
            AND mine.verification_state='verified' AND mine.valid_to IS NULL
          JOIN company_source_relationships theirs ON theirs.source_instance_id=other.source_instance_id
            AND theirs.company_id=mine.company_id AND theirs.verification_state='verified' AND theirs.valid_to IS NULL
          WHERE cjs.active_to IS NULL AND other.external_id=${input.external_id}
          ORDER BY cjs.active_from LIMIT 1`.execute(this.db);
        if (postingMatch.rows[0] !== undefined) {
          canonicalJobId = postingMatch.rows[0].canonical_job_id;
          mergedBy = "posting_id";
        }
      }
    }

    canonicalJobId ??= randomUUID();
    await this.db.transaction().execute(async (trx) => {
      if (mergedBy === "new") {
        await sql`INSERT INTO canonical_jobs(id) VALUES (${canonicalJobId}::uuid)`.execute(trx);
        await insertSourceLink(trx, canonicalJobId, input.source_job_record_id, "primary", "new_canonical", null);
      } else if (mergedBy !== "existing_source") {
        const role = await hasActivePrimary(trx, canonicalJobId) ? "supporting" : "primary";
        await insertSourceLink(trx, canonicalJobId, input.source_job_record_id, role, mergedBy, officialLink?.evidenceId ?? null);
        await sql`INSERT INTO canonical_merge_events(canonical_job_id, source_job_record_id, action, rule, evidence_id)
          VALUES (${canonicalJobId}::uuid, ${input.source_job_record_id}::uuid, 'merge', ${mergedBy},
          ${officialLink?.evidenceId ?? null}::uuid)`.execute(trx);
      }
      await this.maybeSwitchPrimary(trx, canonicalJobId, input);
    });

    const activeInputs = await this.loadActiveInputs(canonicalJobId);
    const primary = activeInputs.find((item) => item.source_role === "primary");
    if (primary === undefined) throw new Error(`Canonical ${canonicalJobId} has no active primary`);
    const structured = mergeStructured(primary, activeInputs.filter((item) => item !== primary));
    const applicationUrl = primary.canonical_url;
    const contentHash = createHash("sha256").update(stableJson({ version: "canonical-v1", applicationUrl, structured })).digest("hex");
    const versionId = randomUUID();
    const inserted = await sql<{ id: string }>`INSERT INTO canonical_job_versions(
        id, canonical_job_id, materialization_version, title, application_url, structured_result, content_hash
      ) VALUES (${versionId}::uuid, ${canonicalJobId}::uuid, 'canonical-v1',
      ${typeof structured.title === "string" ? structured.title : "Untitled"}, ${applicationUrl},
      ${JSON.stringify(structured)}::jsonb, ${contentHash})
      ON CONFLICT (canonical_job_id, content_hash) DO NOTHING RETURNING id`.execute(this.db);
    const versionCreated = inserted.rows[0] !== undefined;
    const canonicalJobVersionId = inserted.rows[0]?.id ?? (await sql<{ id: string }>`SELECT id FROM canonical_job_versions
      WHERE canonical_job_id=${canonicalJobId}::uuid AND content_hash=${contentHash}`.execute(this.db)).rows[0]?.id;
    if (canonicalJobVersionId === undefined) throw new Error("Canonical version disappeared");
    if (versionCreated) await this.persistVersionInputs(canonicalJobId, canonicalJobVersionId, activeInputs);
    return { canonicalJobId, canonicalJobVersionId, mergedBy, versionCreated };
  }

  async unmerge(sourceJobRecordId: string, reason: string): Promise<string> {
    const newCanonicalJobId = randomUUID();
    let oldCanonicalJobId: string | undefined;
    await this.db.transaction().execute(async (trx) => {
      const link = await sql<{ canonical_job_id: string; source_role: "primary" | "supporting" }>`SELECT canonical_job_id, source_role
        FROM canonical_job_sources WHERE source_job_record_id=${sourceJobRecordId}::uuid AND active_to IS NULL FOR UPDATE`.execute(trx);
      const current = link.rows[0];
      if (current === undefined) throw new Error("Source record has no active canonical link");
      oldCanonicalJobId = current.canonical_job_id;
      await sql`UPDATE canonical_job_sources SET active_to=GREATEST(clock_timestamp(), active_from + interval '1 microsecond')
        WHERE source_job_record_id=${sourceJobRecordId}::uuid AND active_to IS NULL`.execute(trx);
      if (current.source_role === "primary") await promoteAnySupporting(trx, current.canonical_job_id, sourceJobRecordId);
      await sql`INSERT INTO canonical_jobs(id) VALUES (${newCanonicalJobId}::uuid)`.execute(trx);
      await insertSourceLink(trx, newCanonicalJobId, sourceJobRecordId, "primary", "manual_unmerge", null);
      await sql`INSERT INTO canonical_merge_events(canonical_job_id, source_job_record_id, action, rule, detail)
        VALUES (${current.canonical_job_id}::uuid, ${sourceJobRecordId}::uuid, 'unmerge', 'manual_review',
        ${JSON.stringify({ reason, newCanonicalJobId })}::jsonb)`.execute(trx);
    });
    const latest = await sql<{ id: string }>`SELECT e.id FROM source_job_extractions e JOIN source_job_versions v ON v.id=e.source_job_version_id
      WHERE v.source_job_record_id=${sourceJobRecordId}::uuid AND e.status='succeeded' ORDER BY e.completed_at DESC LIMIT 1`.execute(this.db);
    const extractionId = latest.rows[0]?.id;
    if (extractionId === undefined) throw new Error("Unmerged source has no successful extraction");
    await this.materialize(extractionId);
    if (oldCanonicalJobId !== undefined) {
      const remaining = await sql<{ id: string }>`SELECT e.id FROM canonical_job_sources cjs
        JOIN source_job_versions v ON v.source_job_record_id=cjs.source_job_record_id
        JOIN source_job_extractions e ON e.source_job_version_id=v.id
        WHERE cjs.canonical_job_id=${oldCanonicalJobId}::uuid AND cjs.active_to IS NULL AND e.status='succeeded'
        ORDER BY e.completed_at DESC LIMIT 1`.execute(this.db);
      const remainingExtractionId = remaining.rows[0]?.id;
      if (remainingExtractionId !== undefined) await this.materialize(remainingExtractionId);
      else await this.refreshCanonicalLifecycle(oldCanonicalJobId);
    }
    return newCanonicalJobId;
  }

  private async loadInput(extractionId: string): Promise<InputRow> {
    const result = await sql<InputRow>`SELECT e.id AS extraction_id, e.structured_result, r.id AS source_job_record_id,
      r.source_instance_id, s.source_kind, r.canonical_url, r.normalized_application_url, r.external_id
      FROM source_job_extractions e JOIN source_job_versions v ON v.id=e.source_job_version_id
      JOIN source_job_records r ON r.id=v.source_job_record_id JOIN source_instances s ON s.id=r.source_instance_id
      WHERE e.id=${extractionId}::uuid AND e.status='succeeded'`.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`Successful extraction ${extractionId} does not exist`);
    return row;
  }

  private async loadActiveInputs(canonicalJobId: string): Promise<ActiveInput[]> {
    const result = await sql<ActiveInput>`SELECT cjs.source_job_record_id, cjs.source_role, x.extraction_id, x.structured_result,
      r.canonical_url FROM canonical_job_sources cjs JOIN source_job_records r ON r.id=cjs.source_job_record_id
      JOIN LATERAL (SELECT e.id extraction_id,e.structured_result FROM source_job_versions v
        JOIN source_job_extractions e ON e.source_job_version_id=v.id WHERE v.source_job_record_id=r.id
        AND e.status='succeeded' ORDER BY e.completed_at DESC LIMIT 1) x ON true
      WHERE cjs.canonical_job_id=${canonicalJobId}::uuid AND cjs.active_to IS NULL ORDER BY cjs.source_role DESC`.execute(this.db);
    return result.rows;
  }

  private async maybeSwitchPrimary(trx: Transaction<OutboxDatabase>, canonicalJobId: string, input: InputRow): Promise<void> {
    const current = await sql<{ source_job_record_id: string; source_kind: InputRow["source_kind"] }>`SELECT cjs.source_job_record_id,s.source_kind
      FROM canonical_job_sources cjs JOIN source_job_records r ON r.id=cjs.source_job_record_id
      JOIN source_instances s ON s.id=r.source_instance_id WHERE cjs.canonical_job_id=${canonicalJobId}::uuid
      AND cjs.source_role='primary' AND cjs.active_to IS NULL`.execute(trx);
    const primary = current.rows[0];
    if (primary === undefined || primary.source_job_record_id === input.source_job_record_id) return;
    if (priority(input.source_kind) <= priority(primary.source_kind)) return;
    await sql`UPDATE canonical_job_sources SET active_to=GREATEST(clock_timestamp(), active_from + interval '1 microsecond') WHERE canonical_job_id=${canonicalJobId}::uuid
      AND source_job_record_id IN (${primary.source_job_record_id}::uuid,${input.source_job_record_id}::uuid) AND active_to IS NULL`.execute(trx);
    await insertSourceLink(trx, canonicalJobId, primary.source_job_record_id, "supporting", "primary_switch", null);
    await insertSourceLink(trx, canonicalJobId, input.source_job_record_id, "primary", "primary_switch", null);
    await sql`INSERT INTO canonical_merge_events(canonical_job_id, source_job_record_id, action, rule, detail)
      VALUES (${canonicalJobId}::uuid, ${input.source_job_record_id}::uuid, 'primary_switch', 'source_priority',
      ${JSON.stringify({ from: primary.source_kind, to: input.source_kind })}::jsonb)`.execute(trx);
  }

  private async persistVersionInputs(canonicalJobId: string, versionId: string, inputs: ActiveInput[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      for (const input of inputs) {
        await sql`INSERT INTO canonical_materialization_inputs(canonical_job_version_id, source_job_extraction_id, input_role)
          VALUES (${versionId}::uuid, ${input.extraction_id}::uuid, ${input.source_role})`.execute(trx);
        await sql`INSERT INTO canonical_field_evidence(canonical_job_version_id, field_path, evidence_id)
          SELECT ${versionId}::uuid, field_path, id FROM evidence WHERE source_job_extraction_id=${input.extraction_id}::uuid
          ON CONFLICT DO NOTHING`.execute(trx);
      }
      await sql`UPDATE canonical_jobs SET current_version_id=${versionId}::uuid, updated_at=now(), lifecycle_state=CASE WHEN EXISTS(
        SELECT 1 FROM canonical_job_sources cjs JOIN source_job_records r ON r.id=cjs.source_job_record_id
        WHERE cjs.canonical_job_id=${canonicalJobId}::uuid AND cjs.active_to IS NULL AND r.lifecycle_state='active'
      ) THEN 'active'::job_lifecycle_state ELSE 'closed'::job_lifecycle_state END WHERE id=${canonicalJobId}::uuid`.execute(trx);
      await sql`INSERT INTO outbox_events(aggregate_type, aggregate_id, event_type, payload, dedup_key)
        VALUES ('canonical_job_version', ${versionId}::uuid, 'canonical_job.materialized', ${JSON.stringify({ canonicalJobId, versionId })}::jsonb,
        ${`canonical-materialized:${versionId}`})`.execute(trx);
    });
  }

  private async refreshCanonicalLifecycle(canonicalJobId: string): Promise<void> {
    await sql`UPDATE canonical_jobs SET lifecycle_state=CASE WHEN EXISTS(SELECT 1 FROM canonical_job_sources cjs
      JOIN source_job_records r ON r.id=cjs.source_job_record_id WHERE cjs.canonical_job_id=${canonicalJobId}::uuid
      AND cjs.active_to IS NULL AND r.lifecycle_state='active') THEN 'active'::job_lifecycle_state ELSE 'closed'::job_lifecycle_state END,
      updated_at=now() WHERE id=${canonicalJobId}::uuid`.execute(this.db);
  }
}

async function hasActivePrimary(trx: Transaction<OutboxDatabase>, canonicalJobId: string): Promise<boolean> {
  return (await sql<{ exists: boolean }>`SELECT EXISTS(SELECT 1 FROM canonical_job_sources WHERE canonical_job_id=${canonicalJobId}::uuid
    AND source_role='primary' AND active_to IS NULL) AS exists`.execute(trx)).rows[0]?.exists ?? false;
}

async function insertSourceLink(trx: Transaction<OutboxDatabase>, canonicalId: string, recordId: string,
  role: "primary" | "supporting", reason: string, evidenceId: string | null): Promise<void> {
  await sql`INSERT INTO canonical_job_sources(canonical_job_id, source_job_record_id, source_role, merge_reason, evidence_id)
    VALUES (${canonicalId}::uuid, ${recordId}::uuid, ${role}, ${reason}, ${evidenceId}::uuid)`.execute(trx);
}

async function promoteAnySupporting(trx: Transaction<OutboxDatabase>, canonicalId: string, excludedRecordId: string): Promise<void> {
  const candidate = await sql<{ source_job_record_id: string }>`SELECT source_job_record_id FROM canonical_job_sources
    WHERE canonical_job_id=${canonicalId}::uuid AND active_to IS NULL AND source_job_record_id<>${excludedRecordId}::uuid
    ORDER BY active_from LIMIT 1 FOR UPDATE`.execute(trx);
  const recordId = candidate.rows[0]?.source_job_record_id;
  if (recordId === undefined) return;
  await sql`UPDATE canonical_job_sources SET active_to=GREATEST(clock_timestamp(), active_from + interval '1 microsecond') WHERE canonical_job_id=${canonicalId}::uuid
    AND source_job_record_id=${recordId}::uuid AND active_to IS NULL`.execute(trx);
  await insertSourceLink(trx, canonicalId, recordId, "primary", "unmerge_primary_repair", null);
}

function priority(kind: InputRow["source_kind"]): number {
  return kind === "greenhouse" ? 300 : kind === "schema_org" ? 200 : 100;
}

function mergeStructured(primary: ActiveInput, supporting: ActiveInput[]): Record<string, unknown> {
  const result = structuredCopy(primary.structured_result);
  const conflicts: string[] = [];
  for (const field of ["employmentTypes", "visaSupport", "locations", "languages", "skills", "compensation"] as const) {
    const facts = [primary, ...supporting].map((input) => input.structured_result[field]).filter(isFact);
    const nonUnknown = facts.filter((fact) => fact.state !== "unknown");
    if (nonUnknown.length === 0) {
      result[field] = { state: "unknown", values: [] };
      continue;
    }
    const values = uniqueValues(nonUnknown.flatMap((fact) => fact.values));
    const scalarConflict = (field === "visaSupport" || field === "compensation")
      && new Set(nonUnknown.map((fact) => stableJson(fact.values))).size > 1;
    const sourceConflict = nonUnknown.some((fact) => fact.state === "conflicting") || scalarConflict;
    result[field] = { state: sourceConflict ? "conflicting" : "known", values };
    if (sourceConflict) conflicts.push(field);
  }
  result.sourceConflicts = conflicts;
  return result;
}

function isFact(value: unknown): value is { state: string; values: unknown[] } {
  return value !== null && typeof value === "object" && "state" in value && "values" in value && Array.isArray(value.values);
}

function uniqueValues(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = stableJson(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function structuredCopy(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
