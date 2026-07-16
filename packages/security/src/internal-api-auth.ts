import { timingSafeEqual } from "node:crypto";

export interface InternalApiAuthInput {
  path: string;
  authorization: string | undefined;
  configuredToken: string | undefined;
  production: boolean;
}

export function authorizeInternalApi(input: InternalApiAuthInput): boolean {
  if (input.path === "/health" || input.path.startsWith("/health?") || input.path.startsWith("/health/")) return true;
  if (input.configuredToken === undefined || input.configuredToken.length === 0) return !input.production;
  const expected = Buffer.from(`Bearer ${input.configuredToken}`, "utf8");
  const actual = Buffer.from(input.authorization ?? "", "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function assertProductionApiToken(configuredToken: string | undefined, production: boolean): void {
  if (production && (configuredToken === undefined || configuredToken.length < 32)) {
    throw new Error("API_INTERNAL_TOKEN must contain at least 32 characters in production");
  }
}
