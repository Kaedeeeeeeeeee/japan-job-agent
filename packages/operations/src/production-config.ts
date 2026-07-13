export type ProductionService = "api" | "web" | "worker" | "backup" | "temporal";

export interface ProductionConfigIssue {
  variable: string;
  problem: string;
}

const requiredByService: Record<ProductionService, string[]> = {
  api: ["DATABASE_URL", "API_INTERNAL_TOKEN", "S3_BUCKET", "S3_ENDPOINT", "S3_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  web: ["API_BASE_URL", "API_INTERNAL_TOKEN", "AUTH_SECRET", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "ALLOWED_GITHUB_LOGIN"],
  worker: ["DATABASE_URL", "S3_BUCKET", "S3_ENDPOINT", "S3_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "TEMPORAL_ADDRESS"],
  backup: ["DATABASE_URL", "BACKUP_BUCKET", "S3_ENDPOINT", "S3_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  temporal: ["DB", "POSTGRES_SEEDS", "POSTGRES_USER", "POSTGRES_PWD", "DBNAME", "VISIBILITY_DBNAME"],
};

export function validateProductionConfig(service: ProductionService, env: Readonly<Record<string, string | undefined>>): ProductionConfigIssue[] {
  const issues: ProductionConfigIssue[] = [];
  for (const variable of requiredByService[service]) {
    if (blank(env[variable])) issues.push({ variable, problem: "is required" });
  }
  if (["api", "web"].includes(service)) requireLength(issues, env, "API_INTERNAL_TOKEN", 32);
  if (service === "web") {
    requireLength(issues, env, "AUTH_SECRET", 32);
    if (!blank(env.ALLOWED_GITHUB_LOGIN) && env.ALLOWED_GITHUB_LOGIN !== "Kaedeeeeeeeeee") {
      issues.push({ variable: "ALLOWED_GITHUB_LOGIN", problem: "must equal Kaedeeeeeeeeee" });
    }
    if (!blank(env.API_BASE_URL) && !/^http:\/\/api\.railway\.internal(?::\d+)?$/u.test(env.API_BASE_URL ?? "")) {
      issues.push({ variable: "API_BASE_URL", problem: "must use the private api.railway.internal address" });
    }
  }
  if (["api", "worker", "backup"].includes(service) && !blank(env.DATABASE_URL)) {
    checkUrl(issues, "DATABASE_URL", env.DATABASE_URL ?? "", ["postgres:", "postgresql:"]);
  }
  if (["api", "worker", "backup"].includes(service) && !blank(env.S3_ENDPOINT)) {
    checkUrl(issues, "S3_ENDPOINT", env.S3_ENDPOINT ?? "", ["https:"]);
  }
  if (service === "worker" && !blank(env.TEMPORAL_ADDRESS)
    && !/\.railway\.internal:7233$/u.test(env.TEMPORAL_ADDRESS ?? "")) {
    issues.push({ variable: "TEMPORAL_ADDRESS", problem: "must use a private Railway address on port 7233" });
  }
  if (service === "temporal") {
    if (!blank(env.DB) && env.DB !== "postgres12") issues.push({ variable: "DB", problem: "must equal postgres12" });
    if (!blank(env.DBNAME) && env.DBNAME !== "temporal") issues.push({ variable: "DBNAME", problem: "must equal temporal" });
    if (!blank(env.VISIBILITY_DBNAME) && env.VISIBILITY_DBNAME !== "temporal_visibility") {
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
