export type ProductionService = "api" | "web" | "worker" | "backup" | "temporal";

export interface ProductionConfigIssue {
  variable: string;
  problem: string;
}

const requiredByService: Record<ProductionService, string[]> = {
  api: ["DATABASE_URL", "API_INTERNAL_TOKEN", "S3_BUCKET", "S3_ENDPOINT", "S3_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  web: ["API_BASE_URL", "API_INTERNAL_TOKEN", "AUTH_SECRET", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "ALLOWED_GITHUB_LOGIN"],
  worker: ["DATABASE_URL", "S3_BUCKET", "S3_ENDPOINT", "S3_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "TEMPORAL_ADDRESS"],
  backup: ["DATABASE_URL", "BACKUP_ENCRYPTION_KEY", "BACKUP_BUCKET", "S3_ENDPOINT", "S3_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  temporal: ["DB", "POSTGRES_SEEDS", "POSTGRES_USER", "POSTGRES_PWD", "DBNAME", "VISIBILITY_DBNAME"],
};

const linuxRequiredByService: Record<ProductionService, string[]> = {
  api: ["DATABASE_URL", "API_INTERNAL_TOKEN"],
  web: ["API_BASE_URL", "API_INTERNAL_TOKEN", "AUTH_SECRET", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "ALLOWED_GITHUB_LOGIN", "AUTH_URL"],
  worker: ["DATABASE_URL", "RAW_STORAGE_PATH", "TEMPORAL_ADDRESS"],
  backup: ["DATABASE_URL", "BACKUP_OUTPUT_PATH", "BACKUP_ENCRYPTION_KEY", "BACKUP_BUCKET", "S3_ENDPOINT", "S3_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  temporal: ["DB", "POSTGRES_SEEDS", "POSTGRES_USER", "POSTGRES_PWD"],
};

export function validateProductionConfig(service: ProductionService, env: Readonly<Record<string, string | undefined>>): ProductionConfigIssue[] {
  const issues: ProductionConfigIssue[] = [];
  const deploymentTarget = env.DEPLOYMENT_TARGET === "linux" ? "linux" : "railway";
  for (const variable of (deploymentTarget === "linux" ? linuxRequiredByService : requiredByService)[service]) {
    if (blank(env[variable])) issues.push({ variable, problem: "is required" });
  }
  if (["api", "web"].includes(service)) requireLength(issues, env, "API_INTERNAL_TOKEN", 32);
  if (service === "web") {
    requireLength(issues, env, "AUTH_SECRET", 32);
    if (!blank(env.ALLOWED_GITHUB_LOGIN) && env.ALLOWED_GITHUB_LOGIN !== "Kaedeeeeeeeeee") {
      issues.push({ variable: "ALLOWED_GITHUB_LOGIN", problem: "must equal Kaedeeeeeeeeee" });
    }
    const allowedApiBase = deploymentTarget === "linux" ? /^http:\/\/api(?::\d+)?$/u : /^http:\/\/api\.railway\.internal(?::\d+)?$/u;
    if (!blank(env.API_BASE_URL) && !allowedApiBase.test(env.API_BASE_URL ?? "")) {
      issues.push({ variable: "API_BASE_URL", problem: deploymentTarget === "linux"
        ? "must use the private Compose api service address" : "must use the private api.railway.internal address" });
    }
  }
  if (["api", "worker", "backup"].includes(service) && !blank(env.DATABASE_URL)) {
    checkUrl(issues, "DATABASE_URL", env.DATABASE_URL ?? "", ["postgres:", "postgresql:"]);
  }
  if (["api", "worker", "backup"].includes(service) && !blank(env.S3_ENDPOINT)) {
    checkUrl(issues, "S3_ENDPOINT", env.S3_ENDPOINT ?? "", ["https:"]);
  }
  if (service === "backup" && !blank(env.BACKUP_ENCRYPTION_KEY)) {
    const normalized = env.BACKUP_ENCRYPTION_KEY?.trim() ?? "";
    const decoded = Buffer.from(normalized, "base64");
    if (decoded.byteLength !== 32 || decoded.toString("base64") !== normalized) {
      issues.push({ variable: "BACKUP_ENCRYPTION_KEY", problem: "must be one canonical base64-encoded 32-byte key" });
    }
  }
  if (["api", "worker"].includes(service) && ["AI_ENRICHMENT_ENABLED", "SEMANTIC_RETRIEVAL_ENABLED", "AI_EXPLANATIONS_ENABLED"]
    .some((name) => env[name] === "true")) {
    for (const variable of ["AI_BASE_URL", "AI_API_KEY", "AI_EXTRACTION_MODEL", "AI_EMBEDDING_MODEL", "AI_EXPLANATION_MODEL"]) {
      if (blank(env[variable])) issues.push({ variable, problem: "is required when an AI feature is enabled" });
    }
    if (!blank(env.AI_BASE_URL)) checkUrl(issues, "AI_BASE_URL", env.AI_BASE_URL ?? "", ["https:"]);
  }
  if (service === "worker" && !blank(env.TEMPORAL_ADDRESS)) {
    const allowedTemporal = deploymentTarget === "linux" ? /^temporal:7233$/u : /\.railway\.internal:7233$/u;
    if (!allowedTemporal.test(env.TEMPORAL_ADDRESS ?? "")) issues.push({ variable: "TEMPORAL_ADDRESS",
      problem: deploymentTarget === "linux" ? "must use temporal:7233 inside Compose"
        : "must use a private Railway address on port 7233" });
  }
  if (deploymentTarget === "linux" && service === "worker" && !blank(env.RAW_STORAGE_PATH)
    && !env.RAW_STORAGE_PATH?.startsWith("/")) issues.push({ variable: "RAW_STORAGE_PATH", problem: "must be an absolute mounted path" });
  if (deploymentTarget === "linux" && ["api", "worker", "backup"].includes(service) && !blank(env.DATABASE_URL)) {
    try {
      if (new URL(env.DATABASE_URL ?? "").hostname !== "postgres") {
        issues.push({ variable: "DATABASE_URL", problem: "must use the private Compose postgres host" });
      }
    } catch { /* checkUrl reports the malformed URL. */ }
  }
  if (service === "temporal") {
    if (!blank(env.DB) && env.DB !== "postgres12") issues.push({ variable: "DB", problem: "must equal postgres12" });
    if (deploymentTarget === "railway" && !blank(env.DBNAME) && env.DBNAME !== "temporal") issues.push({ variable: "DBNAME", problem: "must equal temporal" });
    if (deploymentTarget === "railway" && !blank(env.VISIBILITY_DBNAME) && env.VISIBILITY_DBNAME !== "temporal_visibility") {
      issues.push({ variable: "VISIBILITY_DBNAME", problem: "must equal temporal_visibility" });
    }
  }
  return uniqueIssues(issues);
}

export function isProductionService(value: string | undefined): value is ProductionService {
  return value !== undefined && ["api", "web", "worker", "backup", "temporal"].includes(value);
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "" || /^(placeholder|change-me|todo)$/iu.test(value.trim());
}

function requireLength(issues: ProductionConfigIssue[], env: Readonly<Record<string, string | undefined>>, variable: string, minimum: number): void {
  const value = env[variable];
  if (!blank(value) && (value?.length ?? 0) < minimum) issues.push({ variable, problem: `must contain at least ${minimum} characters` });
}

function checkUrl(issues: ProductionConfigIssue[], variable: string, value: string, protocols: string[]): void {
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol)) issues.push({ variable, problem: `must use ${protocols.join(" or ")}` });
    if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      issues.push({ variable, problem: "must not use a loopback host in production" });
    }
  } catch {
    issues.push({ variable, problem: "must be a valid URL" });
  }
}

function uniqueIssues(issues: ProductionConfigIssue[]): ProductionConfigIssue[] {
  return [...new Map(issues.map((issue) => [`${issue.variable}:${issue.problem}`, issue])).values()];
}
