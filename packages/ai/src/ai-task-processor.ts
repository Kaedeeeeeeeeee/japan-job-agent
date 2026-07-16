import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { CanonicalService } from "../../canonical/src/canonical-service.js";
import type { EnrichableJobField } from "../../contracts/src/index.js";
import type { OutboxDatabase } from "../../db/src/outbox.js";
import { ExtractionService } from "../../extraction/src/extraction-service.js";
import type { ParsedJob } from "../../parser/src/deterministic-job-parser.js";
import type { SafeProfile } from "../../profile/src/build-profile.js";
import {
  FIELD_ENRICHMENT_PROMPT_VERSION,
  MATCH_EXPLANATION_PROMPT_VERSION,
  type AiProvider,
  type AiUsage,
} from "./ai-provider.js";
import {
  AiTaskService,
  canonicalJobEmbeddingText,
  enrichableUnknownFields,
  safeProfileEmbeddingText,
  type AiTaskRow,
} from "./ai-task-service.js";
import { mergeAiCandidates } from "./hybrid-extraction.js";
import { JobLocalRag, validateFactCandidates, vectorLiteral } from "./job-local-rag.js";

const enrichmentPayloadSchema = z.object({
  sourceJobVersionId: z.string().uuid(),
  baseExtractionId: z.string().uuid(),
  rawContentHash: z.string().regex(/^[0-9a-f]{64}$/),
  schemaVersion: z.string().min(1),
  parserVersion: z.string().min(1),
  fields: z.array(z.enum(["employmentTypes", "locations", "compensation", "skills", "languages", "experienceRequirements"])).min(1),
});
const sectionEmbeddingPayloadSchema = z.object({ sectionId: z.string().uuid(), contentHash: z.string().regex(/^[0-9a-f]{64}$/) });
const jobEmbeddingPayloadSchema = z.object({ canonicalJobVersionId: z.string().uuid(), contentHash: z.string().regex(/^[0-9a-f]{64}$/) });
const profileEmbeddingPayloadSchema = z.object({ profileVersionId: z.string().uuid(), sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/) });
const explanationPayloadSchema = z.object({
  recommendationRunId: z.string().uuid(), profileVersionId: z.string().uuid(),
  canonicalJobVersionId: z.string().uuid(), inputHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export interface AiTaskProcessorOptions {
  dailyTokenBudget: number;
  concurrency: number;
}

export class AiTaskProcessor {
  private readonly tasks: AiTaskService;

  constructor(
    private readonly db: Kysely<OutboxDatabase>,
    private readonly provider: AiProvider,
    private readonly options: AiTaskProcessorOptions,
  ) {
    this.tasks = new AiTaskService(db);
  }

  async processBatch(workerId: string): Promise<{ claimed: number; succeeded: number; failed: number; budgetExhausted: boolean }> {
    const used = await this.tasks.tokensUsedToday(this.provider.providerKey);
    if (used >= this.options.dailyTokenBudget) return { claimed: 0, succeeded: 0, failed: 0, budgetExhausted: true };
    const claimed = await this.tasks.claim(workerId, this.options.concurrency);
    let succeeded = 0;
    let failed = 0;
    await Promise.all(claimed.map(async (task) => {
      try {
        const result = await this.processTask(task);
        await this.tasks.complete(task.id, result.result, result.usage);
        succeeded += 1;
      } catch (error) {
        const state = await this.tasks.fail(task, error);
        if (state === "terminal_failed") await this.finalizeTerminalFailure(task, error);
        failed += 1;
      }
    }));
    return { claimed: claimed.length, succeeded, failed, budgetExhausted: false };
  }

  private async processTask(task: AiTaskRow): Promise<{ result: Record<string, unknown>; usage: AiUsage }> {
    if (task.task_kind === "field_enrichment") return this.processFieldEnrichment(task);
    if (task.task_kind === "section_embedding") return this.processSectionEmbedding(task);
    if (task.task_kind === "job_embedding") return this.processJobEmbedding(task);
    if (task.task_kind === "profile_embedding") return this.processProfileEmbedding(task);
    return this.processExplanation(task);
  }

  private async processFieldEnrichment(task: AiTaskRow) {
    const payload = enrichmentPayloadSchema.parse(task.payload);
    const headResult = await sql<{
      extraction_id: string;
      source_job_version_id: string;
      structured_result: ParsedJob;
      source_url: string;
    }>`SELECT head.extraction_id,head.source_job_version_id,extraction.structured_result,current_version.source_url
      FROM source_job_versions target_version
      JOIN source_job_extraction_heads head
        ON head.source_job_record_id=target_version.source_job_record_id
      JOIN source_job_extractions extraction ON extraction.id=head.extraction_id
      JOIN source_job_versions current_version ON current_version.id=head.source_job_version_id
      WHERE target_version.id=${payload.sourceJobVersionId}::uuid`.execute(this.db);
    const head = headResult.rows[0];
    if (head === undefined) throw new Error("Field enrichment target has no Extraction Head");
    if (head.source_job_version_id !== payload.sourceJobVersionId) {
      return { result: { skipped: "newer_raw_version" }, usage: emptyUsage() };
    }
    const unknown = new Set(enrichableUnknownFields(head.structured_result));
    const fields = payload.fields.filter((field) => unknown.has(field));
    if (fields.length === 0) return { result: { skipped: "fields_already_resolved" }, usage: emptyUsage() };

    const retrieved = await new JobLocalRag(this.db, this.provider).retrieve(payload.sourceJobVersionId, fields);
    if (retrieved.sections.length === 0) {
      await this.createFieldReviews(payload.sourceJobVersionId, head.extraction_id, fields, "not_parsed", [], task);
      await this.markNeedsReview(payload.sourceJobVersionId, fields);
      return { result: { changedFields: [], reviewFields: fields }, usage: emptyUsage() };
    }
    const response = await this.provider.extractFacts({ title: retrieved.title, fields, sections: retrieved.sections });
    const candidates = validateFactCandidates(response.candidates, retrieved.sections, fields);
    const merged = mergeAiCandidates(head.structured_result, candidates, head.source_url,
      task.prompt_version ?? FIELD_ENRICHMENT_PROMPT_VERSION, task.model_key);
    if (merged.changedFields.length === 0) {
      await this.createFieldReviews(payload.sourceJobVersionId, head.extraction_id, fields, "low_confidence", candidates, task);
      await this.markNeedsReview(payload.sourceJobVersionId, fields);
      return { result: { changedFields: [], reviewFields: fields }, usage: response.usage };
    }

    const parserVersion = `hybrid-v1:${task.prompt_version ?? FIELD_ENRICHMENT_PROMPT_VERSION}:${task.model_key}`;
    const derived = await new ExtractionService(this.db).persistDerived({
      sourceJobVersionId: payload.sourceJobVersionId,
      parentExtractionId: head.extraction_id,
      origin: "hybrid",
      parserKey: "hybrid-job",
      parserVersion,
      schemaVersion: "job-v3",
      promptVersion: task.prompt_version ?? FIELD_ENRICHMENT_PROMPT_VERSION,
      modelKey: task.model_key,
      structured: merged.structured,
      evidence: merged.evidence,
    });
    const materialized = await new CanonicalService(this.db, { enrichmentEnabled: false }).materialize(derived.extractionId);
    const remaining = fields.filter((field) => !merged.changedFields.includes(field));
    if (remaining.length > 0) {
      await this.createFieldReviews(payload.sourceJobVersionId, derived.extractionId, remaining, "low_confidence", candidates, task);
    }
    const readiness = await sql<{ readiness: string; content_hash: string }>`SELECT readiness,content_hash FROM canonical_job_versions
      WHERE id=${materialized.canonicalJobVersionId}::uuid`.execute(this.db);
    if (readiness.rows[0]?.readiness === "ready") {
      await enqueueJobEmbedding(this.tasks, this.provider, materialized.canonicalJobVersionId, readiness.rows[0].content_hash);
    }
    return { result: { extractionId: derived.extractionId, canonicalJobVersionId: materialized.canonicalJobVersionId,
      changedFields: merged.changedFields, reviewFields: remaining }, usage: response.usage };
  }

  private async processSectionEmbedding(task: AiTaskRow) {
    const payload = sectionEmbeddingPayloadSchema.parse(task.payload);
    const section = await sql<{ section_text: string; text_hash: string }>`SELECT section_text,text_hash FROM canonical_document_sections
      WHERE id=${payload.sectionId}::uuid`.execute(this.db);
    const row = section.rows[0];
    if (row === undefined || row.text_hash !== payload.contentHash) return { result: { skipped: "section_changed" }, usage: emptyUsage() };
    const embedded = await this.provider.embed([row.section_text]);
    const vector = embedded.vectors[0];
    if (vector === undefined) throw new Error("Embedding provider returned no Section vector");
    await sql`INSERT INTO canonical_document_section_embeddings(
        canonical_document_section_id,model_key,dimensions,content_hash,embedding
      ) VALUES (${payload.sectionId}::uuid,${task.model_key},${vector.length},${payload.contentHash},${vectorLiteral(vector)}::vector)
      ON CONFLICT(canonical_document_section_id,model_key,content_hash) DO NOTHING`.execute(this.db);
    return { result: { dimensions: vector.length }, usage: embedded.usage };
  }

  private async processJobEmbedding(task: AiTaskRow) {
    const payload = jobEmbeddingPayloadSchema.parse(task.payload);
    const job = await sql<{ title: string; structured_result: Record<string, unknown>; content_hash: string; readiness: string }>`
      SELECT title,structured_result,content_hash,readiness FROM canonical_job_versions
      WHERE id=${payload.canonicalJobVersionId}::uuid`.execute(this.db);
    const row = job.rows[0];
    if (row === undefined || row.content_hash !== payload.contentHash || row.readiness !== "ready") {
      return { result: { skipped: "job_not_currently_ready" }, usage: emptyUsage() };
    }
    const text = canonicalJobEmbeddingText(row.title, row.structured_result);
    const embedded = await this.provider.embed([text]);
    const vector = embedded.vectors[0];
    if (vector === undefined) throw new Error("Embedding provider returned no Job vector");
    await sql`INSERT INTO canonical_job_embeddings(canonical_job_version_id,model_key,dimensions,content_hash,embedding)
      VALUES (${payload.canonicalJobVersionId}::uuid,${task.model_key},${vector.length},${sha256(text)},${vectorLiteral(vector)}::vector)
      ON CONFLICT(canonical_job_version_id,model_key,content_hash) DO NOTHING`.execute(this.db);
    return { result: { dimensions: vector.length }, usage: embedded.usage };
  }

  private async processProfileEmbedding(task: AiTaskRow) {
    const payload = profileEmbeddingPayloadSchema.parse(task.payload);
    const profile = await sql<{ structured_profile: SafeProfile; source_fingerprint: string; contains_direct_pii: boolean }>`
      SELECT structured_profile,source_fingerprint,contains_direct_pii FROM profile_versions
      WHERE id=${payload.profileVersionId}::uuid`.execute(this.db);
    const row = profile.rows[0];
    if (row === undefined || row.source_fingerprint !== payload.sourceFingerprint) {
      return { result: { skipped: "profile_changed" }, usage: emptyUsage() };
    }
    if (row.contains_direct_pii) throw new Error("Profile Embedding refuses a Profile Version containing direct PII");
    const text = safeProfileEmbeddingText(row.structured_profile);
    const embedded = await this.provider.embed([text]);
    const vector = embedded.vectors[0];
    if (vector === undefined) throw new Error("Embedding provider returned no Profile vector");
    await sql`INSERT INTO profile_embeddings(profile_version_id,model_key,dimensions,content_hash,embedding)
      VALUES (${payload.profileVersionId}::uuid,${task.model_key},${vector.length},${sha256(text)},${vectorLiteral(vector)}::vector)
      ON CONFLICT(profile_version_id,model_key,content_hash) DO NOTHING`.execute(this.db);
    return { result: { dimensions: vector.length }, usage: embedded.usage };
  }

  private async processExplanation(task: AiTaskRow) {
    const payload = explanationPayloadSchema.parse(task.payload);
    const cache = await sql<{ input_hash: string }>`SELECT input_hash FROM recommendation_explanations
      WHERE profile_version_id=${payload.profileVersionId}::uuid
        AND canonical_job_version_id=${payload.canonicalJobVersionId}::uuid
        AND prompt_version=${task.prompt_version ?? MATCH_EXPLANATION_PROMPT_VERSION}`.execute(this.db);
    if (cache.rows[0]?.input_hash !== payload.inputHash) {
      await sql`UPDATE recommendation_results SET explanation_status='failed'
        WHERE recommendation_run_id=${payload.recommendationRunId}::uuid
          AND canonical_job_version_id=${payload.canonicalJobVersionId}::uuid`.execute(this.db);
      return { result: { skipped: "superseded_explanation_input" }, usage: emptyUsage() };
    }
    const input = await sql<{
      structured_profile: SafeProfile;
      title: string;
      structured_result: Record<string, unknown>;
      score_breakdown: Record<string, unknown>;
      explanation: Record<string, unknown>;
    }>`SELECT profile.structured_profile,job.title,job.structured_result,result.score_breakdown,result.explanation
      FROM recommendation_results result
      JOIN profile_versions profile ON profile.id=${payload.profileVersionId}::uuid
      JOIN canonical_job_versions job ON job.id=result.canonical_job_version_id
      WHERE result.recommendation_run_id=${payload.recommendationRunId}::uuid
        AND result.canonical_job_version_id=${payload.canonicalJobVersionId}::uuid`.execute(this.db);
    const row = input.rows[0];
    if (row === undefined) throw new Error("Recommendation explanation input does not exist");
    const evidence = await sql<{ id: string }>`SELECT DISTINCT evidence_id::text id FROM canonical_field_evidence
      WHERE canonical_job_version_id=${payload.canonicalJobVersionId}::uuid ORDER BY evidence_id::text`.execute(this.db);
    const allowedEvidenceIds = evidence.rows.map((item) => item.id);
    const explanation = await this.provider.explainMatch({
      safeProfileSummary: safeProfileEmbeddingText(row.structured_profile),
      title: row.title,
      verifiedFacts: verifiedFactsForExplanation(row.structured_result),
      deterministicResult: { scoreBreakdown: row.score_breakdown, ...row.explanation },
      allowedEvidenceIds,
    });
    const usedEvidence = [...new Set([...explanation.matched, ...explanation.gaps].flatMap((claim) => claim.evidenceIds))];
    await sql`UPDATE recommendation_explanations SET status='succeeded',
      explanation=${JSON.stringify({ summary: explanation.summary, matched: explanation.matched, gaps: explanation.gaps })}::jsonb,
      evidence_ids=${usedEvidence}::uuid[],last_error=NULL,completed_at=now(),updated_at=now()
      WHERE profile_version_id=${payload.profileVersionId}::uuid
        AND canonical_job_version_id=${payload.canonicalJobVersionId}::uuid
        AND prompt_version=${task.prompt_version ?? MATCH_EXPLANATION_PROMPT_VERSION}
        AND input_hash=${payload.inputHash}`.execute(this.db);
    await sql`UPDATE recommendation_results SET explanation_status='succeeded'
      WHERE recommendation_run_id=${payload.recommendationRunId}::uuid
        AND canonical_job_version_id=${payload.canonicalJobVersionId}::uuid`.execute(this.db);
    return { result: { evidenceIds: usedEvidence }, usage: explanation.usage };
  }

  private async finalizeTerminalFailure(task: AiTaskRow, error: unknown): Promise<void> {
    if (task.task_kind === "field_enrichment") {
      const payload = enrichmentPayloadSchema.safeParse(task.payload);
      if (!payload.success) return;
      const head = await sql<{ extraction_id: string; structured_result: ParsedJob; source_url: string }>`
        SELECT head.extraction_id,extraction.structured_result,version.source_url
        FROM source_job_extraction_heads head
        JOIN source_job_extractions extraction ON extraction.id=head.extraction_id
        JOIN source_job_versions version ON version.id=head.source_job_version_id
        WHERE head.source_job_version_id=${payload.data.sourceJobVersionId}::uuid`.execute(this.db);
      const row = head.rows[0];
      if (row === undefined) return;
      const structured = clone(row.structured_result);
      const fields = payload.data.fields.filter((field) => {
        const fact = structured[field];
        if (!isUnknownFact(fact)) return false;
        fact.unknownReason = "provider_failed";
        return true;
      });
      if (fields.length === 0) return;
      const derived = await new ExtractionService(this.db).persistDerived({
        sourceJobVersionId: payload.data.sourceJobVersionId,
        parentExtractionId: row.extraction_id,
        origin: "hybrid",
        parserKey: "hybrid-job",
        parserVersion: `hybrid-v1:${task.prompt_version ?? FIELD_ENRICHMENT_PROMPT_VERSION}:${task.model_key}:provider-failed`,
        schemaVersion: "job-v3",
        promptVersion: task.prompt_version ?? FIELD_ENRICHMENT_PROMPT_VERSION,
        modelKey: task.model_key,
        structured,
        evidence: [],
      });
      await new CanonicalService(this.db, { enrichmentEnabled: false }).materialize(derived.extractionId);
      await this.createFieldReviews(payload.data.sourceJobVersionId, derived.extractionId, fields,
        "provider_failed", [], task);
      return;
    }
    if (task.task_kind === "recommendation_explanation") {
      const payload = explanationPayloadSchema.safeParse(task.payload);
      if (!payload.success) return;
      const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
      await sql`UPDATE recommendation_explanations SET status='failed',last_error=${message},completed_at=now(),updated_at=now()
        WHERE profile_version_id=${payload.data.profileVersionId}::uuid
          AND canonical_job_version_id=${payload.data.canonicalJobVersionId}::uuid
          AND prompt_version=${task.prompt_version ?? MATCH_EXPLANATION_PROMPT_VERSION}
          AND input_hash=${payload.data.inputHash}`.execute(this.db);
      await sql`UPDATE recommendation_results SET explanation_status='failed'
        WHERE recommendation_run_id=${payload.data.recommendationRunId}::uuid
          AND canonical_job_version_id=${payload.data.canonicalJobVersionId}::uuid`.execute(this.db);
    }
  }

  private async createFieldReviews(sourceJobVersionId: string, extractionId: string, fields: readonly EnrichableJobField[],
    reason: "not_parsed" | "low_confidence" | "provider_failed", candidates: readonly unknown[], task: AiTaskRow): Promise<void> {
    for (const field of fields) {
      const idempotencyKey = sha256(stableJson({ sourceJobVersionId, extractionId, field, reason,
        promptVersion: task.prompt_version, modelKey: task.model_key }));
      await sql`INSERT INTO field_review_tasks(
          id,source_job_version_id,extraction_id,field_name,reason,candidate_quotes,prompt_version,model_key,idempotency_key
        ) VALUES (
          ${randomUUID()}::uuid,${sourceJobVersionId}::uuid,${extractionId}::uuid,${field},${reason}::fact_unknown_reason,
          ${JSON.stringify(candidates)}::jsonb,${task.prompt_version},${task.model_key},${idempotencyKey}
        ) ON CONFLICT(idempotency_key) DO NOTHING`.execute(this.db);
    }
  }

  private async markNeedsReview(sourceJobVersionId: string, fields: readonly EnrichableJobField[]): Promise<void> {
    const reasons = fields.flatMap((field) => field === "employmentTypes" ? ["employment_unresolved"]
      : field === "locations" ? ["location_unresolved"] : []);
    if (reasons.length === 0) return;
    await sql`UPDATE canonical_job_versions version SET readiness='needs_review',
      readiness_reasons=(SELECT array_agg(DISTINCT reason) FROM unnest(version.readiness_reasons || ${reasons}::text[]) reason)
      FROM canonical_jobs job JOIN canonical_job_sources source ON source.canonical_job_id=job.id
      JOIN source_job_versions raw ON raw.source_job_record_id=source.source_job_record_id
      WHERE version.id=job.current_version_id AND source.active_to IS NULL
        AND raw.id=${sourceJobVersionId}::uuid`.execute(this.db);
  }
}

export async function enqueueFieldEnrichment(
  tasks: AiTaskService,
  provider: AiProvider,
  input: {
    sourceJobVersionId: string;
    baseExtractionId: string;
    rawContentHash: string;
    schemaVersion: string;
    parserVersion: string;
    fields: readonly EnrichableJobField[];
  },
) {
  if (input.fields.length === 0) return null;
  return tasks.enqueue({
    kind: "field_enrichment",
    payload: { ...input, fields: [...input.fields] },
    providerKey: provider.providerKey,
    modelKey: provider.extractionModelKey,
    promptVersion: FIELD_ENRICHMENT_PROMPT_VERSION,
    idempotencyParts: [input.rawContentHash, input.schemaVersion, input.parserVersion,
      FIELD_ENRICHMENT_PROMPT_VERSION, provider.extractionModelKey],
  });
}

export async function enqueueSectionEmbeddings(
  db: Kysely<OutboxDatabase>,
  tasks: AiTaskService,
  provider: AiProvider,
  sourceJobVersionId: string,
) {
  const sections = await sql<{ id: string; text_hash: string }>`SELECT section.id,section.text_hash
    FROM canonical_documents document JOIN canonical_document_sections section ON section.canonical_document_id=document.id
    WHERE document.source_job_version_id=${sourceJobVersionId}::uuid
    ORDER BY document.created_at DESC,section.ordinal`.execute(db);
  return Promise.all(sections.rows.map((section) => tasks.enqueue({
    kind: "section_embedding",
    payload: { sectionId: section.id, contentHash: section.text_hash },
    providerKey: provider.providerKey,
    modelKey: provider.embeddingModelKey,
    idempotencyParts: [section.text_hash, provider.embeddingModelKey, "section-embedding-v1"],
  })));
}

export async function enqueueJobEmbedding(
  tasks: AiTaskService,
  provider: AiProvider,
  canonicalJobVersionId: string,
  contentHash: string,
) {
  return tasks.enqueue({ kind: "job_embedding", payload: { canonicalJobVersionId, contentHash },
    providerKey: provider.providerKey, modelKey: provider.embeddingModelKey,
    idempotencyParts: [contentHash, provider.embeddingModelKey, "job-embedding-v1"] });
}

export async function enqueueProfileEmbedding(
  tasks: AiTaskService,
  provider: AiProvider,
  profileVersionId: string,
  sourceFingerprint: string,
) {
  return tasks.enqueue({ kind: "profile_embedding", payload: { profileVersionId, sourceFingerprint },
    providerKey: provider.providerKey, modelKey: provider.embeddingModelKey,
    idempotencyParts: [sourceFingerprint, provider.embeddingModelKey, "profile-embedding-v1"] });
}

export async function enqueueRecommendationExplanation(
  db: Kysely<OutboxDatabase>,
  tasks: AiTaskService,
  provider: AiProvider,
  input: {
    recommendationRunId: string;
    profileVersionId: string;
    canonicalJobVersionId: string;
    inputHash: string;
  },
) {
  await sql`INSERT INTO recommendation_explanations(
      profile_version_id,canonical_job_version_id,prompt_version,model_key,status,input_hash
    ) VALUES (
      ${input.profileVersionId}::uuid,${input.canonicalJobVersionId}::uuid,${MATCH_EXPLANATION_PROMPT_VERSION},
      ${provider.explanationModelKey},'pending',${input.inputHash}
    ) ON CONFLICT(profile_version_id,canonical_job_version_id,prompt_version) DO UPDATE SET
      status=CASE WHEN recommendation_explanations.input_hash=EXCLUDED.input_hash
        AND recommendation_explanations.model_key=EXCLUDED.model_key
        AND recommendation_explanations.status='succeeded' THEN recommendation_explanations.status ELSE 'pending' END,
      model_key=EXCLUDED.model_key,input_hash=EXCLUDED.input_hash,
      explanation=CASE WHEN recommendation_explanations.input_hash=EXCLUDED.input_hash
        THEN recommendation_explanations.explanation ELSE '{}'::jsonb END,
      evidence_ids=CASE WHEN recommendation_explanations.input_hash=EXCLUDED.input_hash
        THEN recommendation_explanations.evidence_ids ELSE '{}'::uuid[] END,
      last_error=NULL,
      completed_at=CASE WHEN recommendation_explanations.input_hash=EXCLUDED.input_hash
        AND recommendation_explanations.model_key=EXCLUDED.model_key
        AND recommendation_explanations.status='succeeded' THEN recommendation_explanations.completed_at ELSE NULL END,
      updated_at=now()`.execute(db);
  return tasks.enqueue({ kind: "recommendation_explanation", payload: input,
    providerKey: provider.providerKey, modelKey: provider.explanationModelKey,
    promptVersion: MATCH_EXPLANATION_PROMPT_VERSION,
    idempotencyParts: [input.inputHash, MATCH_EXPLANATION_PROMPT_VERSION, provider.explanationModelKey] });
}

function isUnknownFact(value: unknown): value is { state: "unknown"; values: []; unknownReason?: string } {
  return value !== null && typeof value === "object" && "state" in value && value.state === "unknown";
}

function emptyUsage(): AiUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function verifiedFactsForExplanation(structured: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(structured).filter(([field]) => field !== "descriptionText"));
}
