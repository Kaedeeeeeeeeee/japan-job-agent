import { describe, expect, it, vi } from "vitest";
import { SchemaOrgConnector, assertPublicHttpsUrl } from "./schema-org-connector.js";

const identity = {
  sourceInstanceId: "11111111-1111-4111-8111-111111111111",
  stableKey: "page",
  canonicalUrl: "https://careers.example.com/jobs/engineer",
};
const fixture = `<!doctype html><script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "JobPosting",
  identifier: { "@type": "PropertyValue", value: "JOB-27" },
  title: "27卒 Web Engineer",
  url: identity.canonicalUrl,
  jobLocation: { "@type": "Place", address: { addressRegion: "東京都" } },
})}</script>`;

describe("SchemaOrgConnector", () => {
  it("fetches one exact HTML record and derives a stable identity", async () => {
    const connector = new SchemaOrgConnector(
      vi.fn(async () => new Response(fixture, { status: 200, headers: { "content-type": "text/html" } })),
      async () => ["203.0.113.10"],
    );
    const record = await connector.fetchRecord(identity, AbortSignal.timeout(1_000));
    expect(record.identity).toMatchObject({ stableKey: "JOB-27", externalId: "JOB-27" });
    expect(new TextDecoder().decode(record.raw)).toBe(fixture);
  });

  it("blocks loopback before issuing a request", async () => {
    const fetchSpy = vi.fn();
    const connector = new SchemaOrgConnector(fetchSpy, async () => ["127.0.0.1"]);
    await expect(connector.fetchRecord(identity, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: "ssrf_blocked" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("validates every redirect target and blocks a private redirect", async () => {
    const connector = new SchemaOrgConnector(
      vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://internal.example/job" } })),
      async (host) => host === "internal.example" ? ["10.0.0.2"] : ["203.0.113.10"],
    );
    await expect(connector.fetchRecord(identity, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: "ssrf_blocked" });
  });

  it("rejects plain HTTP and URL credentials", async () => {
    await expect(assertPublicHttpsUrl(new URL("http://example.com"), async () => ["203.0.113.10"]))
      .rejects.toMatchObject({ code: "ssrf_blocked" });
    await expect(assertPublicHttpsUrl(new URL("https://user:pass@example.com"), async () => ["203.0.113.10"]))
      .rejects.toMatchObject({ code: "ssrf_blocked" });
  });

  it("reports HTTP 410 as explicit record closure evidence", async () => {
    const connector = new SchemaOrgConnector(async () => new Response(null, { status: 410 }), async () => ["203.0.113.10"]);
    await expect(connector.fetchRecord(identity, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: "record_closed" });
  });

  it("treats an explicit past validThrough as closed", async () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "Expired",
      url: identity.canonicalUrl, validThrough: "2026-06-30T23:59:59+09:00" })}</script>`;
    const connector = new SchemaOrgConnector(async () => new Response(html, { status: 200 }), async () => ["203.0.113.10"],
      5 * 1024 * 1024, () => new Date("2026-07-14T00:00:00+09:00"));
    await expect(connector.fetchRecord(identity, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: "record_closed" });
  });
});
