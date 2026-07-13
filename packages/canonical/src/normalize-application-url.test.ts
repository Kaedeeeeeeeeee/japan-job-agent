import { describe, expect, it } from "vitest";
import { normalizeApplicationUrl } from "./normalize-application-url.js";

describe("normalizeApplicationUrl", () => {
  it("removes fragments, trailing slash, default ports, and tracking only", () => {
    expect(normalizeApplicationUrl("https://EXAMPLE.com:443/jobs/1/?utm_source=x&team=web#apply"))
      .toBe("https://example.com/jobs/1?team=web");
  });

  it("keeps semantic query parameters in stable order", () => {
    expect(normalizeApplicationUrl("https://example.com/apply?role=2&lang=ja&utm_campaign=x"))
      .toBe("https://example.com/apply?lang=ja&role=2");
  });
});

