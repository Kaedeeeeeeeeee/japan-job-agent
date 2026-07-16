import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { SourceKind } from "../../contracts/src/index.js";
import type { OutboxDatabase } from "../../db/src/outbox.js";
import { normalizeApplicationUrl } from "./normalize-application-url.js";

interface InputRow {
  extraction_id: string;
  structured_result: Record<string, unknown>;
  source_job_record_id: string;
  source_instance_id: string;
  source_kind: SourceKind;
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
  extraction_origin: "deterministic" | "hybrid" | "manual";
}

export interface MaterializationResult {
  canonicalJobId: string;
  canonicalJobVersionId: string;
  mergedBy: "existing_source" | "application_url" | "posting_id" | "official_link" | "new";
  versionCreated: boolean;
}

export class CanonicalService {
  constructor(
    private readonly db: Kysely<OutboxDatabase>,
    private readonly options: { enrichmentEnabled?: boolean } = {},
  ) {}

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
    const readiness = determineReadiness(structured, primary.extraction_origin,
      this.options.enrichmentEnabled ?? process.env.AI_ENRICHMENT_ENABLED === "true");
    const contentHash = createHash("sha256").update(stableJson({
      version: "canonical-v3", applicationUrl, structured, readiness,
      inputs: activeInputs.map((value) => ({ extractionId: value.extraction_id, role: value.source_role })),
    })).digest("hex");
    const versionId = randomUUID();
    const inserted = await sql<{ id: string }>`INSERT INTO canonical_job_versions(
        id, canonical_job_id, materialization_version, title, application_url, structured_result, content_hash,
        readiness,readiness_reasons
      ) VALUES (${versionId}::uuid, ${canonicalJobId}::uuid, 'canonical-v3',
      ${typeof structured.title === "string" ? structured.title : "Untitled"}, ${applicationUrl},
      ${JSON.stringify(structured)}::jsonb, ${contentHash},${readiness.state}::job_readiness,${readiness.reasons}::text[])
      ON CONFLICT (canonical_job_id, content_hash) DO NOTHING RETURNING id`.execute(this.db);
    const versionCreated = inserted.rows[0] !== undefined;
    const canonicalJobVersionId = inserted.rows[0]?.id ?? (await sql<{ id: string }>`SELECT id FROM canonical_job_versions
      WHERE canonical_job_id=${canonicalJobId}::uuid AND content_hash=${contentHash}`.execute(this.db)).rows[0]?.id;
    if (canonicalJobVersionId === undefined) throw new Error("Canonical version disappeared");
    if (versionCreated) await this.persistVersionInputs(canonicalJobId, canonicalJobVersionId, activeInputs, structured);
    if (readiness.state === "needs_review" && primary.extraction_origin === "deterministic") {
      await this.ensureDeterministicReviewTasks(primary.extraction_id, structured);
    }
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
    const latest = await sql<{ id: string }>`SELECT h.extraction_id id FROM source_job_extraction_heads h
      WHERE h.source_job_record_id=${sourceJobRecordId}::uuid`.execute(this.db);
    const extractionId = latest.rows[0]?.id;
    if (extractionId === undefined) throw new Error("Unmerged source has no successful extraction");
    await this.materialize(extractionId);
    if (oldCanonicalJobId !== undefined) {
      const remaining = await sql<{ id: string }>`SELECT h.extraction_id id FROM canonical_job_sources cjs
        JOIN source_job_extraction_heads h ON h.source_job_record_id=cjs.source_job_record_id
        WHERE cjs.canonical_job_id=${oldCanonicalJobId}::uuid AND cjs.active_to IS NULL
        ORDER BY cjs.source_role DESC,cjs.active_from LIMIT 1`.execute(this.db);
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
    const result = await sql<ActiveInput>`SELECT cjs.source_job_record_id,cjs.source_role,e.id extraction_id,e.structured_result,
      r.canonical_url,lineage.origin extraction_origin
      FROM canonical_job_sources cjs JOIN source_job_records r ON r.id=cjs.source_job_record_id
      JOIN source_job_extraction_heads head ON head.source_job_record_id=r.id
      JOIN source_job_extractions e ON e.id=head.extraction_id
      JOIN source_job_extraction_lineage lineage ON lineage.extraction_id=e.id
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

  private async persistVersionInputs(
    canonicalJobId: string,
    versionId: string,
    inputs: ActiveInput[],
    structured: Record<string, unknown>,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      for (const input of inputs) {
        await sql`INSERT INTO canonical_materialization_inputs(canonical_job_version_id, source_job_extraction_id, input_role)
          VALUES (${versionId}::uuid, ${input.extraction_id}::uuid, ${input.source_role})`.execute(trx);
        await sql`INSERT INTO canonical_field_evidence(canonical_job_version_id, field_path, evidence_id)
          SELECT ${versionId}::uuid, field_path, id FROM evidence WHERE source_job_extraction_id=${input.extraction_id}::uuid
          ON CONFLICT DO NOTHING`.execute(trx);
        await sql`INSERT INTO canonical_field_evidence(canonical_job_version_id, field_path, evidence_id)
          SELECT ${versionId}::uuid, 'sourceVerification', e.id
          FROM source_job_records r
          JOIN company_source_relationships csr ON csr.source_instance_id=r.source_instance_id
            AND csr.verification_state='verified' AND csr.valid_to IS NULL
          JOIN evidence e ON e.company_source_relationship_id=csr.id
          WHERE r.id=${input.source_job_record_id}::uuid
          ON CONFLICT DO NOTHING`.execute(trx);
        await sql`INSERT INTO canonical_job_dates(
            canonical_job_version_id, date_kind, precision, date_value, timestamp_value, source_role, evidence_id
          ) SELECT ${versionId}::uuid, d.date_kind, d.precision, d.date_value, d.timestamp_value,
            ${input.source_role}, d.evidence_id
          FROM extraction_job_dates d WHERE d.extraction_id=${input.extraction_id}::uuid
          ON CONFLICT DO NOTHING`.execute(trx);
      }
      const jobDates = structured.jobDates;
      for (const [kind, field] of [
        ["published", "published"],
        ["source_updated", "sourceUpdated"],
        ["valid_through", "validThrough"],
      ] as const) {
        const state = factState(jobDates, field);
        await sql`INSERT INTO canonical_job_date_states(canonical_job_version_id, date_kind, value_state)
          VALUES (${versionId}::uuid, ${kind}::job_date_kind, ${state}::explicit_value_state)`.execute(trx);
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

  private async ensureDeterministicReviewTasks(
    extractionId: string,
    structured: Record<string, unknown>,
  ): Promise<void> {
    for (const field of ["employmentTypes", "locations"] as const) {
      const fact = isFact(structured[field]) ? structured[field] : { state: "unknown", values: [] };
      if (fact.state === "known") continue;
      const reason = fact.state === "unknown" && typeof fact.unknownReason === "string"
        && ["not_mentioned", "not_parsed", "unsupported_format", "low_confidence", "provider_failed"].includes(fact.unknownReason)
        ? fact.unknownReason : "low_confidence";
      const idempotencyKey = createHash("sha256").update(stableJson({ extractionId, field, reason,
        source: "deterministic_readiness" })).digest("hex");
      await sql`INSERT INTO field_review_tasks(
          source_job_version_id,extraction_id,field_name,reason,candidate_quotes,idempotency_key
        ) SELECT extraction.source_job_version_id,extraction.id,${field},${reason}::fact_unknown_reason,'[]'::jsonb,
          ${idempotencyKey}
        FROM source_job_extractions extraction WHERE extraction.id=${extractionId}::uuid
        ON CONFLICT(idempotency_key) DO NOTHING`.execute(this.db);
    }
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
  if (["greenhouse", "smartrecruiters", "lever", "ashby", "workday"].includes(kind)) return 300;
  if (["schema_org", "hrmos", "herp", "jobcan", "airwork", "engage", "talentio"].includes(kind)) return 200;
  return 100;
}

function mergeStructured(primary: ActiveInput, supporting: ActiveInput[]): Record<string, unknown> {
  const result = structuredCopy(primary.structured_result);
  const conflicts: string[] = [];
  for (const field of ["employmentTypes", "visaSupport", "locations", "languages", "skills", "compensation"] as const) {
    const facts = [primary, ...supporting].map((input) => input.structured_result[field]).filter(isFact);
    const nonUnknown = facts.filter((fact) => fact.state !== "unknown");
    if (nonUnknown.length === 0) {
      result[field] = { state: "unknown", values: [], unknownReason: strongestUnknownReason(facts) };
      continue;
    }
    const values = uniqueValues(nonUnknown.flatMap((fact) => fact.values));
    const scalarConflict = (field === "visaSupport" || field === "compensation")
      && new Set(nonUnknown.map((fact) => stableJson(fact.values))).size > 1;
    const sourceConflict = nonUnknown.some((fact) => fact.state === "conflicting") || scalarConflict;
    result[field] = { state: sourceConflict ? "conflicting" : "known", values };
    if (sourceConflict) conflicts.push(field);
  }
  result.jobDates = mergeJobDates(primary, supporting, conflicts);
  result.sourceConflicts = conflicts;
  return result;
}

function mergeJobDates(
  primary: ActiveInput,
  supporting: ActiveInput[],
  conflicts: string[],
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of ["published", "sourceUpdated", "validThrough"] as const) {
    const facts = [primary, ...supporting]
      .map((input) => nestedDateFact(input.structured_result, field))
      .filter((fact): fact is { state: string; values: unknown[] } => fact !== null);
    const nonUnknown = facts.filter((fact) => fact.state !== "unknown");
    if (nonUnknown.length === 0) {
      output[field] = { state: "unknown", values: [], unknownReason: strongestUnknownReason(facts) };
      continue;
    }
    const values = uniqueValues(nonUnknown.flatMap((fact) => fact.values));
    const conflict = nonUnknown.some((fact) => fact.state === "conflicting") || values.length > 1;
    output[field] = { state: conflict ? "conflicting" : "known", values };
    if (conflict) conflicts.push(`jobDates.${field}`);
  }
  return output;
}

function nestedDateFact(value: Record<string, unknown>, field: string): { state: string; values: unknown[] } | null {
  const dates = value.jobDates;
  if (dates === null || typeof dates !== "object") return null;
  const fact = (dates as Record<string, unknown>)[field];
  return isFact(fact) ? fact : null;
}

function factState(jobDates: unknown, field: string): "known" | "unknown" | "conflicting" {
  if (jobDates === null || typeof jobDates !== "object") return "unknown";
  const value = (jobDates as Record<string, unknown>)[field];
  if (!isFact(value)) return "unknown";
  return value.state === "known" || value.state === "conflicting" ? value.state : "unknown";
}

function isFact(value: unknown): value is { state: string; values: unknown[]; unknownReason?: unknown } {
  return value !== null && typeof value === "object" && "state" in value && "values" in value && Array.isArray(value.values);
}

function strongestUnknownReason(facts: Array<{ state: string; values: unknown[] }>): string {
  const order = ["provider_failed", "low_confidence", "unsupported_format", "not_parsed", "not_mentioned"];
  const reasons = facts.flatMap((fact) => {
    const value = (fact as { unknownReason?: unknown }).unknownReason;
    return typeof value === "string" ? [value] : [];
  });
  return order.find((candidate) => reasons.includes(candidate)) ?? "not_parsed";
}

function determineReadiness(
  structured: Record<string, unknown>,
  primaryOrigin: ActiveInput["extraction_origin"],
  enrichmentEnabled: boolean,
): { state: "ready" | "pending_enrichment" | "needs_review"; reasons: string[] } {
  const employment = isFact(structured.employmentTypes) ? structured.employmentTypes : { state: "unknown", values: [] };
  const locations = isFact(structured.locations) ? structured.locations : { state: "unknown", values: [] };
  const reasons = [
    ...(employment.state === "known" ? [] : ["employment_unresolved"]),
    ...(locations.state === "known" ? [] : ["location_unresolved"]),
  ];
  if (reasons.length === 0) return { state: "ready", reasons: [] };
  if (employment.state === "conflicting" || locations.state === "conflicting") return { state: "needs_review", reasons };
  return { state: enrichmentEnabled && primaryOrigin === "deterministic" ? "pending_enrichment" : "needs_review", reasons };
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
