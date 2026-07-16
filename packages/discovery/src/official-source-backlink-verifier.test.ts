import { describe, expect, it } from "vitest";
import { verifyOfficialSourceBacklink } from "./official-source-backlink-verifier.js";

describe("official source backlink verification", () => {
  it("never treats an ATS page itself as the corporate-domain proof", async () => {
    const result = await verifyOfficialSourceBacklink(
      "https://open.talentio.com/r/1/c/example/homes/42",
      "talentio",
      "example",
      async () => new Response("unused"),
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("corporate_url_is_recruitment_platform");
  });

  it("follows only corporate recruitment links and verifies the exact ATS tenant", async () => {
    const requested: string[] = [];
    const result = await verifyOfficialSourceBacklink("http://example.com", "talentio", "acme", async (input) => {
      const url = String(input);
      requested.push(url);
      if (new URL(url).pathname === "/") return new Response('<a href="/recruit/">採用情報</a>');
      return new Response('<a href="https://open.talentio.com/r/1/c/acme/homes/42">募集中の職種</a>');
    }, 3);
    expect(result.verified).toBe(true);
    expect(result.evidencePageUrl).toBe("https://example.com/recruit/");
    expect(result.detectedSource).toMatchObject({ kind: "talentio", tenantKey: "acme" });
    expect(requested).toEqual(["https://example.com/", "https://example.com/recruit/"]);
  });

  it("does not accept a different tenant or crawl off the corporate site", async () => {
    const result = await verifyOfficialSourceBacklink("https://example.com", "talentio", "acme", async (input) => {
      const url = String(input);
      if (new URL(url).hostname === "example.com") return new Response(
        '<a href="https://careers.evil.example/jobs">採用</a><a href="https://open.talentio.com/r/1/c/other/homes/9">求人</a>');
      throw new Error("off-site URL must not be fetched");
    }, 3);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("ats_backlink_not_found");
    expect(result.audits).toHaveLength(1);
  });
});
