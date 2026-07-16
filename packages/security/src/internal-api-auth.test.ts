import { describe, expect, it } from "vitest";
import { assertProductionApiToken, authorizeInternalApi } from "./internal-api-auth.js";

const token = "a-secure-internal-token-with-32-chars";

describe("internal API authentication", () => {
  it("leaves only health public", () => {
    expect(authorizeInternalApi({ path: "/health", authorization: undefined, configuredToken: token, production: true })).toBe(true);
    expect(authorizeInternalApi({ path: "/health/ready", authorization: undefined, configuredToken: token, production: true })).toBe(true);
    expect(authorizeInternalApi({ path: "/agent/jobs", authorization: undefined, configuredToken: token, production: true })).toBe(false);
    expect(authorizeInternalApi({ path: "/admin/sources", authorization: `Bearer ${token}`, configuredToken: token, production: true })).toBe(true);
  });

  it("permits tokenless local development but never tokenless production", () => {
    expect(authorizeInternalApi({ path: "/agent/jobs", authorization: undefined, configuredToken: undefined, production: false })).toBe(true);
    expect(authorizeInternalApi({ path: "/agent/jobs", authorization: undefined, configuredToken: undefined, production: true })).toBe(false);
    expect(() => assertProductionApiToken(undefined, true)).toThrow(/API_INTERNAL_TOKEN/);
    expect(() => assertProductionApiToken("short", true)).toThrow(/32/);
    expect(() => assertProductionApiToken(token, true)).not.toThrow();
  });
});
