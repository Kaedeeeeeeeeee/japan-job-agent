import { describe, expect, it } from "vitest";
import type { SafeProfile } from "../../profile/src/build-profile.js";
import type { ParsedJob } from "../../parser/src/deterministic-job-parser.js";
import { aiTaskIdempotencyKey, enrichableUnknownFields, isRetryableAiError, safeProfileEmbeddingText } from "./ai-task-service.js";

describe("AI task invariants", () => {
  it("includes task kind and all version inputs in deterministic idempotency keys", () => {
    const first = aiTaskIdempotencyKey("field_enrichment", ["raw", "job-v3", "parser-1", "prompt-1", "model-1"]);
    expect(first).toBe(aiTaskIdempotencyKey("field_enrichment", ["raw", "job-v3", "parser-1", "prompt-1", "model-1"]));
    expect(first).not.toBe(aiTaskIdempotencyKey("field_enrichment", ["raw", "job-v3", "parser-1", "prompt-2", "model-1"]));
    expect(first).not.toBe(aiTaskIdempotencyKey("job_embedding", ["raw", "job-v3", "parser-1", "prompt-1", "model-1"]));
  });

  it("only schedules fields that deterministic parsing left unknown", () => {
    const job = {
      employmentTypes: { state: "known", values: ["permanent"] },
      locations: { state: "unknown", values: [], unknownReason: "not_parsed" },
      compensation: { state: "unknown", values: [], unknownReason: "unsupported_format" },
      skills: { state: "known", values: [] }, languages: { state: "known", values: [] },
      experienceRequirements: { state: "known", values: [] },
    } as unknown as ParsedJob;
    expect(enrichableUnknownFields(job)).toEqual(["locations", "compensation"]);
  });

  it("builds a SafeProfile-only embedding payload", () => {
    const profile = {
      schemaVersion: "profile-v1", targetChannels: ["experienced"], rolePriorities: [], locations: {},
      employment: {}, languages: [], visa: {}, compensation: {}, normalizedSkills: ["React"],
      experienceSignals: [], piiPolicy: { directPiiStored: false, extractionMode: "allowlist_only" },
      name: "must-not-leak", email: "must-not-leak@example.com",
    } as unknown as SafeProfile;
    const summary = safeProfileEmbeddingText(profile);
    expect(summary).toContain("React");
    expect(summary).not.toContain("must-not-leak");
  });

  it("retries transient and malformed provider responses but not invalid evidence", () => {
    expect(isRetryableAiError(Object.assign(new Error("rate limited"), { status: 429 }))).toBe(true);
    expect(isRetryableAiError(new Error("AI provider returned invalid JSON"))).toBe(true);
    expect(isRetryableAiError(Object.assign(new Error("unauthorized"), { status: 401 }))).toBe(false);
    expect(isRetryableAiError(new Error("quote is not in section"))).toBe(false);
  });
});
