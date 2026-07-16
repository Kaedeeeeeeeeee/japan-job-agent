import { promises as fs } from "node:fs";
import path from "node:path";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { ParserContext, SourceJobVersion, SourceKind } from "../packages/contracts/src/index.js";
import { buildCanonicalDocument } from "../packages/canonical-document/src/canonical-document.js";
import type { OutboxDatabase } from "../packages/db/src/outbox.js";
import { ExtractionService } from "../packages/extraction/src/extraction-service.js";
import { CanonicalService } from "../packages/canonical/src/canonical-service.js";
import { DeterministicJobParser, type ParsedJob } from "../packages/parser/src/deterministic-job-parser.js";
import { createObjectStore } from "./object-store-config.js";

interface ReplayRow {
  id: string;
  source_job_record_id: string;
  raw_hash: string;
  content_hash: string;
  canonicalization_version: string;
  raw_storage_key: string;
  source_url: string;
  fetched_at: Date;
  source_instance_id: string;
  source_kind: SourceKind;
  tenant_key: string;
  base_url: string;
  head_source_job_version_id: string | null;
  previous_structured: ParsedJob | null;
  previous_readiness: string | null;
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
const apply = process.argv.includes("--apply");
const limit = integerArgument("--limit", 10_000);
const reportArgument = stringArgument("--report");
const reportPath = path.resolve(reportArgument ?? `output/hybrid-parser-shadow-${new Date().toISOString().replaceAll(":", "-")}.json`);
const enrichmentEnabled = process.env.AI_ENRICHMENT_ENABLED === "true";
const { Pool } = pg;
const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl }) }) });
const store = createObjectStore();
const parser = new DeterministicJobParser();

try {
  const selected = await sql<ReplayRow>`SELECT version.id,version.source_job_record_id,version.raw_hash,version.content_hash,
      version.canonicalization_version,version.raw_storage_key,version.source_url,version.fetched_at,
      source.id source_instance_id,source.source_kind,source.tenant_key,source.base_url,
      head.source_job_version_id head_source_job_version_id,extraction.structured_result previous_structured,
      canonical_version.readiness::text previous_readiness
    FROM source_job_versions version
    JOIN source_job_records record ON record.id=version.source_job_record_id
    JOIN source_instances source ON source.id=record.source_instance_id
    LEFT JOIN source_job_extraction_heads head ON head.source_job_record_id=record.id
    LEFT JOIN source_job_extractions extraction ON extraction.id=head.extraction_id
    LEFT JOIN canonical_job_sources canonical_source ON canonical_source.source_job_record_id=record.id
      AND canonical_source.active_to IS NULL
    LEFT JOIN canonical_jobs canonical_job ON canonical_job.id=canonical_source.canonical_job_id
    LEFT JOIN canonical_job_versions canonical_version ON canonical_version.id=canonical_job.current_version_id
    ORDER BY version.fetched_at,version.id LIMIT ${limit}`.execute(db);

  const admissionChanges: Array<Record<string, unknown>> = [];
  const factChanges: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, string>> = [];
  const invalidHighRiskEvidence: Array<Record<string, string>> = [];
  const sourceCounts: Record<string, number> = {};
  const unknownCounts: Record<string, number> = {};
  let succeeded = 0;
  let applied = 0;

  for (const row of selected.rows) {
    sourceCounts[row.source_kind] = (sourceCounts[row.source_kind] ?? 0) + 1;
    try {
      const raw = await store.get(row.raw_storage_key);
      const version: SourceJobVersion = {
        id: row.id, sourceJobRecordId: row.source_job_record_id, rawHash: row.raw_hash, contentHash: row.content_hash,
        canonicalizationVersion: row.canonicalization_version, raw, sourceUrl: row.source_url,
        fetchedAt: row.fetched_at.toISOString(),
      };
      const context: ParserContext = { source: { id: row.source_instance_id, sourceKind: row.source_kind,
        tenantKey: row.tenant_key, baseUrl: row.base_url }, localeHints: ["ja-JP"] };
      const document = buildCanonicalDocument(version, context);
      const candidate = await parser.parseCanonical(version, context, document);
      if (candidate.status !== "succeeded") {
        failures.push({ sourceJobVersionId: row.id, error: candidate.errors.join("; ") });
        continue;
      }
      succeeded += 1;
      const structured = candidate.structured as ParsedJob;
      for (const field of ["employmentTypes", "locations"] as const) {
        if (structured[field].state === "unknown") continue;
        const evidence = candidate.evidence.filter((item) => item.fieldPath === field);
        const valid = evidence.length > 0 && evidence.every((item) => {
          const ordinal = item.locator.sectionOrdinal;
          return typeof ordinal === "number" && document.sections[ordinal]?.text.includes(item.quotedText) === true;
        });
        if (!valid) invalidHighRiskEvidence.push({ sourceJobVersionId: row.id, field,
          error: evidence.length === 0 ? "missing evidence" : "quote does not map to its Canonical Section" });
      }
      for (const field of ["employmentTypes", "locations", "compensation", "skills", "languages"] as const) {
        if (structured[field].state === "unknown") unknownCounts[field] = (unknownCounts[field] ?? 0) + 1;
      }
      const proposedReadiness = readiness(structured, enrichmentEnabled);
      if (row.head_source_job_version_id === row.id) {
        const previous = row.previous_structured;
        const before = previous === null ? null : factSnapshot(previous);
        const after = factSnapshot(structured);
        if (stableJson(before) !== stableJson(after)) {
          factChanges.push({ sourceJobRecordId: row.source_job_record_id, sourceJobVersionId: row.id, sourceKind: row.source_kind,
            sourceUrl: row.source_url, before, after });
        }
        const admissionBefore = previous === null ? null : admissionSnapshot(previous);
        const admissionAfter = admissionSnapshot(structured);
        if (stableJson(admissionBefore) !== stableJson(admissionAfter) || row.previous_readiness !== proposedReadiness) {
          admissionChanges.push({ sourceJobRecordId: row.source_job_record_id, sourceJobVersionId: row.id, sourceKind: row.source_kind,
            sourceUrl: row.source_url, previousReadiness: row.previous_readiness, proposedReadiness,
            before: admissionBefore, after: admissionAfter });
        }
      }
      if (apply) {
        const extraction = await new ExtractionService(db, store).extract(row.id, parser);
        if (extraction.status === "succeeded") {
          await new CanonicalService(db, { enrichmentEnabled }).materialize(extraction.extractionId);
          applied += 1;
        }
      }
    } catch (error) {
      failures.push({ sourceJobVersionId: row.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(), mode: apply ? "apply" : "shadow", parserKey: parser.parserKey,
    parserVersion: parser.parserVersion, schemaVersion: parser.schemaVersion, selected: selected.rows.length,
    succeeded, failed: failures.length, applied, sourceCounts, unknownCounts,
    admissionChangeCount: admissionChanges.length, admissionChanges,
    factChangeCount: factChanges.length, factChanges,
    highRiskEvidenceValid: invalidHighRiskEvidence.length === 0,
    invalidHighRiskEvidenceCount: invalidHighRiskEvidence.length, invalidHighRiskEvidence, failures,
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...report, admissionChanges: undefined, factChanges: undefined,
    invalidHighRiskEvidence: undefined, failures: undefined, reportPath })}\n`);
  if (failures.length > 0 || invalidHighRiskEvidence.length > 0) process.exitCode = 2;
} finally {
  await db.destroy();
}

function readiness(job: ParsedJob, canEnrich: boolean): "ready" | "pending_enrichment" | "needs_review" {
  if (job.employmentTypes.state === "known" && job.locations.state === "known") return "ready";
  if (job.employmentTypes.state === "conflicting" || job.locations.state === "conflicting") return "needs_review";
  return canEnrich ? "pending_enrichment" : "needs_review";
}

function admissionSnapshot(job: ParsedJob): Record<string, unknown> {
  return { employmentTypes: comparableFact(job.employmentTypes), locations: comparableFact(job.locations) };
}

function factSnapshot(job: ParsedJob): Record<string, unknown> {
  return { ...admissionSnapshot(job), compensation: comparableFact(job.compensation),
    skills: comparableFact(job.skills), languages: comparableFact(job.languages) };
}

function comparableFact(fact: { state: string; values: unknown[] }): Record<string, unknown> {
  return { state: fact.state, values: fact.values };
}

function integerArgument(name: string, fallback: number): number {
  const raw = stringArgument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100_000) throw new Error(`${name} must be an integer from 1 to 100000`);
  return value;
}

function stringArgument(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
