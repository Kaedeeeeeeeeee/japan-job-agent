import { describe, expect, it } from "vitest";
import { validateProductionConfig, type ProductionService } from "./production-config.js";

const shared = {
  DATABASE_URL: "postgresql://user:secret@postgres.railway.internal:5432/jja",
  API_INTERNAL_TOKEN: "a".repeat(32),
  S3_BUCKET: "private-raw",
  BACKUP_BUCKET: "private-backups",
  BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  S3_ENDPOINT: "https://bucket.railway.app",
  S3_REGION: "asia-southeast1",
  AWS_ACCESS_KEY_ID: "access",
  AWS_SECRET_ACCESS_KEY: "secret",
  TEMPORAL_ADDRESS: "temporal.railway.internal:7233",
  API_BASE_URL: "http://api.railway.internal:3000",
  AUTH_SECRET: "b".repeat(32),
  AUTH_GITHUB_ID: "github-id",
  AUTH_GITHUB_SECRET: "github-secret",
  ALLOWED_GITHUB_LOGIN: "Kaedeeeeeeeeee",
  DB: "postgres12",
  POSTGRES_SEEDS: "postgres.railway.internal",
  POSTGRES_USER: "temporal",
  POSTGRES_PWD: "secret",
  DBNAME: "temporal",
  VISIBILITY_DBNAME: "temporal_visibility",
  AI_ENRICHMENT_ENABLED: "false",
  SEMANTIC_RETRIEVAL_ENABLED: "false",
  AI_EXPLANATIONS_ENABLED: "false",
};

describe("production service preflight", () => {
  it.each<ProductionService>(["api", "web", "worker", "backup", "temporal"])("accepts a complete %s environment", (service) => {
    expect(validateProductionConfig(service, shared)).toEqual([]);
  });

  it("reports variable names without echoing secret values", () => {
    const issues = validateProductionConfig("web", {
      API_BASE_URL: "http://127.0.0.1:3001",
      API_INTERNAL_TOKEN: "secret-value",
      AUTH_SECRET: "secret-value",
      AUTH_GITHUB_ID: "placeholder",
      AUTH_GITHUB_SECRET: "secret-value",
      ALLOWED_GITHUB_LOGIN: "someone-else",
    });
    expect(issues.map((issue) => issue.variable)).toEqual(expect.arrayContaining([
      "API_BASE_URL", "API_INTERNAL_TOKEN", "AUTH_SECRET", "AUTH_GITHUB_ID", "ALLOWED_GITHUB_LOGIN",
    ]));
    expect(JSON.stringify(issues)).not.toContain("secret-value");
  });

  it("requires provider credentials and all model keys when AI is enabled", () => {
    const issues = validateProductionConfig("worker", { ...shared, AI_ENRICHMENT_ENABLED: "true" });
    expect(issues.map((issue) => issue.variable)).toEqual(expect.arrayContaining([
      "AI_BASE_URL", "AI_API_KEY", "AI_EXTRACTION_MODEL", "AI_EMBEDDING_MODEL", "AI_EXPLANATION_MODEL",
    ]));
    expect(validateProductionConfig("worker", { ...shared, AI_ENRICHMENT_ENABLED: "true",
      AI_BASE_URL: "https://ai.example/v1", AI_API_KEY: "secret", AI_EXTRACTION_MODEL: "extract",
      AI_EMBEDDING_MODEL: "embed", AI_EXPLANATION_MODEL: "explain" })).toEqual([]);
  });

  it.each<ProductionService>(["api", "web", "worker", "backup", "temporal"])("accepts R2-backed Linux %s configuration", (service) => {
    const linux = { ...shared, DEPLOYMENT_TARGET: "linux", DATABASE_URL: "postgresql://postgres:secret@postgres:5432/jja",
      API_BASE_URL: "http://api:3000", AUTH_URL: "https://jja.example-tailnet.ts.net", RAW_STORAGE_PATH: "/data/raw",
      BACKUP_OUTPUT_PATH: "/data/backups/jja.dump.enc", TEMPORAL_ADDRESS: "temporal:7233", POSTGRES_SEEDS: "postgres",
      S3_BUCKET: undefined, DBNAME: undefined, VISIBILITY_DBNAME: undefined };
    expect(validateProductionConfig(service, linux)).toEqual([]);
  });

  it("requires authenticated encrypted offsite Linux backups", () => {
    const issues = validateProductionConfig("backup", { ...shared, DEPLOYMENT_TARGET: "linux",
      DATABASE_URL: "postgresql://postgres:secret@postgres:5432/jja", BACKUP_ENCRYPTION_KEY: "too-short" });
    expect(issues.map((issue) => issue.variable)).toContain("BACKUP_ENCRYPTION_KEY");
    expect(JSON.stringify(issues)).not.toContain("too-short");
  });
});
