import { describe, expect, it, vi } from "vitest";
import { loadAiProviderConfig, OpenAiCompatibleProvider, type AiProviderConfig } from "./ai-provider.js";

const config: AiProviderConfig = {
  providerKey: "test", baseUrl: "https://ai.example/v1", apiKey: "secret",
  extractionModelKey: "extract", embeddingModelKey: "embed", explanationModelKey: "explain",
  timeoutMs: 1_000, concurrency: 2, dailyTokenBudget: 10_000,
};

describe("OpenAI-compatible AI provider", () => {
  it("stays disabled without configuration and validates enabled configuration", () => {
    expect(loadAiProviderConfig({})).toBeNull();
    expect(() => loadAiProviderConfig({ AI_ENRICHMENT_ENABLED: "true" })).toThrow("AI_BASE_URL");
    expect(loadAiProviderConfig({ AI_ENRICHMENT_ENABLED: "true", AI_BASE_URL: "https://ai.example/v1",
      AI_API_KEY: "x", AI_EXTRACTION_MODEL: "e", AI_EMBEDDING_MODEL: "v", AI_EXPLANATION_MODEL: "x" }))
      .toMatchObject({ concurrency: 2, dailyTokenBudget: 1_000_000 });
  });

  it("rejects candidates whose field was not requested", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [
      { field: "locations", quote: "東京都", sectionId: crypto.randomUUID(), rawValue: "東京都", normalizedCandidate: "Tokyo", requirementKind: "mentioned" },
      { field: "skills", quote: "React", sectionId: crypto.randomUUID(), rawValue: "React", normalizedCandidate: "react", requirementKind: "required" },
    ] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 })) as typeof fetch;
    const provider = new OpenAiCompatibleProvider(config, fetchMock);
    const sectionId = crypto.randomUUID();
    const result = await provider.extractFacts({ title: "Engineer", fields: ["locations"],
      sections: [{ id: sectionId, kind: "location", heading: "勤務地", text: "東京都" }] });
    expect(result.candidates.map((candidate) => candidate.field)).toEqual(["locations"]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("rejects an explanation that invents an Evidence ID", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      summary: "一致", matched: [{ field: "skills", message: "React", evidenceIds: [crypto.randomUUID()] }], gaps: [],
    }) } }] }), { status: 200 })) as typeof fetch;
    const provider = new OpenAiCompatibleProvider(config, fetchMock);
    await expect(provider.explainMatch({ safeProfileSummary: "skills: React", title: "Engineer", verifiedFacts: {},
      deterministicResult: {}, allowedEvidenceIds: [crypto.randomUUID()] })).rejects.toThrow("outside");
  });

  it("requires consistent embedding dimensions", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [
      { index: 0, embedding: [1, 2] }, { index: 1, embedding: [1] },
    ] }), { status: 200 })) as typeof fetch;
    const provider = new OpenAiCompatibleProvider(config, fetchMock);
    await expect(provider.embed(["one", "two"])).rejects.toThrow("inconsistent dimensions");
  });
});
