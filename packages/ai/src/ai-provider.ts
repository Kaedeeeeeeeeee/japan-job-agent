import { z } from "zod";
import type { AiFactCandidate, EnrichableJobField } from "../../contracts/src/index.js";

export const FIELD_ENRICHMENT_PROMPT_VERSION = "field-enrichment-v1";
export const MATCH_EXPLANATION_PROMPT_VERSION = "match-explanation-ja-v1";

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface RetrievedSection {
  id: string;
  kind: string;
  heading: string | null;
  text: string;
}

export interface ExtractFactsRequest {
  title: string;
  fields: readonly EnrichableJobField[];
  sections: readonly RetrievedSection[];
}

export interface ExplainMatchRequest {
  safeProfileSummary: string;
  title: string;
  verifiedFacts: Readonly<Record<string, unknown>>;
  deterministicResult: Readonly<Record<string, unknown>>;
  allowedEvidenceIds: readonly string[];
}

export interface ExplanationClaim {
  field: string;
  message: string;
  evidenceIds: string[];
}

export interface AiMatchExplanation {
  summary: string;
  matched: ExplanationClaim[];
  gaps: ExplanationClaim[];
  usage: AiUsage;
}

export interface AiProvider {
  readonly providerKey: string;
  readonly extractionModelKey: string;
  readonly embeddingModelKey: string;
  readonly explanationModelKey: string;
  extractFacts(request: ExtractFactsRequest, signal?: AbortSignal): Promise<{ candidates: AiFactCandidate[]; usage: AiUsage }>;
  embed(inputs: readonly string[], signal?: AbortSignal): Promise<{ vectors: number[][]; usage: AiUsage }>;
  explainMatch(request: ExplainMatchRequest, signal?: AbortSignal): Promise<AiMatchExplanation>;
}

export interface AiProviderConfig {
  providerKey: string;
  baseUrl: string;
  apiKey: string;
  extractionModelKey: string;
  embeddingModelKey: string;
  explanationModelKey: string;
  timeoutMs: number;
  concurrency: number;
  dailyTokenBudget: number;
}

const factCandidateSchema = z.object({
  field: z.enum(["employmentTypes", "locations", "compensation", "skills", "languages", "experienceRequirements"]),
  quote: z.string().min(1),
  sectionId: z.string().uuid(),
  rawValue: z.string().min(1),
  normalizedCandidate: z.unknown(),
  requirementKind: z.enum(["required", "preferred", "mentioned"]),
});
const factResponseSchema = z.object({ candidates: z.array(factCandidateSchema) });
const claimSchema = z.object({ field: z.string().min(1), message: z.string().min(1), evidenceIds: z.array(z.string().uuid()) });
const explanationResponseSchema = z.object({
  summary: z.string().min(1),
  matched: z.array(claimSchema),
  gaps: z.array(claimSchema),
});
const chatResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.union([z.string(), z.record(z.string(), z.unknown())]) }) })).min(1),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative().optional(), completion_tokens: z.number().int().nonnegative().optional() }).optional(),
});
const embeddingResponseSchema = z.object({
  data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number().finite()).min(1) })),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative().optional(), total_tokens: z.number().int().nonnegative().optional() }).optional(),
});

export class OpenAiCompatibleProvider implements AiProvider {
  readonly providerKey: string;
  readonly extractionModelKey: string;
  readonly embeddingModelKey: string;
  readonly explanationModelKey: string;
  private readonly baseUrl: string;

  constructor(
    private readonly config: AiProviderConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.providerKey = config.providerKey;
    this.extractionModelKey = config.extractionModelKey;
    this.embeddingModelKey = config.embeddingModelKey;
    this.explanationModelKey = config.explanationModelKey;
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
  }

  async extractFacts(request: ExtractFactsRequest, signal?: AbortSignal) {
    const response = await this.chat(this.extractionModelKey, [
      { role: "system", content: `You extract job facts from only the supplied sections. Return JSON {"candidates":[]}.
Every candidate must contain field, an exact verbatim quote, sectionId, rawValue, normalizedCandidate, and requirementKind.
Only return requested unknown fields. Never infer absence, never use outside knowledge, and never combine different sections.` },
      { role: "user", content: JSON.stringify(request) },
    ], signal);
    const parsed = factResponseSchema.parse(parseJsonContent(response.content));
    const requested = new Set(request.fields);
    return { candidates: parsed.candidates.filter((candidate) => requested.has(candidate.field)), usage: response.usage };
  }

  async embed(inputs: readonly string[], signal?: AbortSignal) {
    if (inputs.length === 0) return { vectors: [], usage: { inputTokens: 0, outputTokens: 0 } };
    const response = embeddingResponseSchema.parse(await this.request("/embeddings", {
      model: this.embeddingModelKey,
      input: inputs,
    }, signal));
    const sorted = [...response.data].sort((left, right) => left.index - right.index);
    if (sorted.length !== inputs.length) throw new Error(`Embedding provider returned ${sorted.length}/${inputs.length} vectors`);
    const dimensions = sorted[0]?.embedding.length;
    if (dimensions === undefined || sorted.some((item) => item.embedding.length !== dimensions)) {
      throw new Error("Embedding provider returned inconsistent dimensions");
    }
    return { vectors: sorted.map((item) => item.embedding), usage: {
      inputTokens: response.usage?.prompt_tokens ?? response.usage?.total_tokens ?? 0,
      outputTokens: 0,
    } };
  }

  async explainMatch(request: ExplainMatchRequest, signal?: AbortSignal): Promise<AiMatchExplanation> {
    const response = await this.chat(this.explanationModelKey, [
      { role: "system", content: `Write a concise Japanese job recommendation explanation. Return JSON with summary, matched, and gaps.
Every matched/gaps claim must cite one or more Evidence IDs from allowedEvidenceIds. Do not add facts, change eligibility, or change ranking.` },
      { role: "user", content: JSON.stringify(request) },
    ], signal);
    const parsed = explanationResponseSchema.parse(parseJsonContent(response.content));
    const allowed = new Set(request.allowedEvidenceIds);
    for (const claim of [...parsed.matched, ...parsed.gaps]) {
      if (claim.evidenceIds.length === 0 || claim.evidenceIds.some((id) => !allowed.has(id))) {
        throw new Error("Explanation cited evidence outside the current Canonical Job Version");
      }
    }
    return { ...parsed, usage: response.usage };
  }

  private async chat(model: string, messages: Array<{ role: string; content: string }>, signal?: AbortSignal) {
    const response = chatResponseSchema.parse(await this.request("/chat/completions", {
      model,
      messages,
      temperature: 0,
      response_format: { type: "json_object" },
    }, signal));
    const content = response.choices[0]?.message.content;
    if (content === undefined) throw new Error("AI provider returned no message content");
    return { content, usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    } };
  }

  private async request(path: string, body: Record<string, unknown>, outerSignal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = outerSignal === undefined ? timeout : AbortSignal.any([outerSignal, timeout]);
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`AI provider HTTP ${response.status}: ${text.slice(0, 500)}`);
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("AI provider returned invalid JSON");
    }
  }
}

export function loadAiProviderConfig(environment: Readonly<Record<string, string | undefined>> = process.env): AiProviderConfig | null {
  const enabled = ["AI_ENRICHMENT_ENABLED", "SEMANTIC_RETRIEVAL_ENABLED", "AI_EXPLANATIONS_ENABLED"]
    .some((name) => environment[name] === "true");
  const values = ["AI_BASE_URL", "AI_API_KEY", "AI_EXTRACTION_MODEL", "AI_EMBEDDING_MODEL", "AI_EXPLANATION_MODEL"] as const;
  if (!enabled && values.every((name) => environment[name] === undefined || environment[name] === "")) return null;
  for (const name of values) if (environment[name] === undefined || environment[name] === "") throw new Error(`${name} is required when AI features are configured`);
  return {
    providerKey: environment.AI_PROVIDER_KEY ?? "openai-compatible",
    baseUrl: environment.AI_BASE_URL!,
    apiKey: environment.AI_API_KEY!,
    extractionModelKey: environment.AI_EXTRACTION_MODEL!,
    embeddingModelKey: environment.AI_EMBEDDING_MODEL!,
    explanationModelKey: environment.AI_EXPLANATION_MODEL!,
    timeoutMs: positiveInt(environment.AI_TIMEOUT_MS, 30_000, "AI_TIMEOUT_MS"),
    concurrency: positiveInt(environment.AI_CONCURRENCY, 2, "AI_CONCURRENCY"),
    dailyTokenBudget: positiveInt(environment.AI_DAILY_TOKEN_BUDGET, 1_000_000, "AI_DAILY_TOKEN_BUDGET"),
  };
}

export function createAiProviderFromEnv(environment: Readonly<Record<string, string | undefined>> = process.env): OpenAiCompatibleProvider | null {
  const config = loadAiProviderConfig(environment);
  return config === null ? null : new OpenAiCompatibleProvider(config);
}

function parseJsonContent(content: string | Record<string, unknown>): unknown {
  if (typeof content !== "string") return content;
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    throw new Error("AI provider message content was not valid JSON");
  }
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
