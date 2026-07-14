import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SourceJobVersion } from "../../contracts/src/index.js";
import { DeterministicJobParser } from "./deterministic-job-parser.js";

function version(payload: string): SourceJobVersion {
  return {
    id: randomUUID(),
    sourceJobRecordId: randomUUID(),
    rawHash: "a".repeat(64),
    contentHash: "b".repeat(64),
    canonicalizationVersion: "fixture",
    raw: new TextEncoder().encode(payload),
    sourceUrl: "https://example.com/jobs/27",
    fetchedAt: "2026-07-13T00:00:00.000Z",
  };
}

const context = {
  source: {
    id: "11111111-1111-4111-8111-111111111111",
    sourceKind: "greenhouse" as const,
    tenantKey: "fixture",
    baseUrl: "https://example.com",
  },
  localeHints: ["ja-JP"],
};

describe("DeterministicJobParser", () => {
  it("extracts multivalue facts and preserves contradictory visa evidence", async () => {
    const raw = JSON.stringify({
      title: "27卒 Web / AI Engineer",
      absolute_url: "https://example.com/jobs/27",
      location: { name: "Tokyo (Remote/Hybrid)" },
      content: `<p>雇用形態: 正社員 または 契約社員</p><p>応募要件: JLPT N1、TypeScript、React、Node.js、AI、Web開発経験3年以上</p>
        <p>Visa sponsorship is available. No visa sponsorship for this employment track.</p><p>年収 400万円〜600万円</p>`,
    });
    const result = await new DeterministicJobParser().parse(version(raw), context);
    expect(result.status).toBe("succeeded");
    expect(result.structured.employmentTypes).toMatchObject({ state: "known", values: ["permanent", "fixed_term"] });
    expect(result.structured.visaSupport).toEqual({ state: "conflicting", values: [true, false] });
    expect(result.structured.locations).toMatchObject({ state: "known" });
    expect(result.structured.languages).toMatchObject({ state: "known" });
    expect(result.structured.compensation).toMatchObject({ state: "known" });
    expect(result.structured.experienceRequirements).toMatchObject({ state: "known", values: [{ minimumYears: 3 }] });
    for (const field of ["title", "employmentTypes", "visaSupport", "locations", "languages", "skills", "compensation"]) {
      expect(result.evidence.some((item) => item.fieldPath === field), `${field} evidence`).toBe(true);
    }
  });

  it("replays a schema.org JobPosting HTML fixture", async () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      title: "Web Engineer",
      employmentType: "FULL_TIME",
      description: "<p>正社員 / Python / 日本語ビジネス</p>",
      jobLocation: { address: { addressRegion: "東京都", addressCountry: "JP" } },
    })}</script>`;
    const result = await new DeterministicJobParser().parse(version(html), context);
    expect(result.status).toBe("succeeded");
    expect(result.structured).toMatchObject({ title: "Web Engineer", employmentTypes: { state: "known" }, locations: { state: "known" } });
  });

  it("preserves explicit non-Japan country evidence for hard location filtering", async () => {
    const result = await new DeterministicJobParser().parse(version(JSON.stringify({
      title: "Backend Engineer", location: { name: "Taipei, Taiwan" }, content: "<p>Full-time backend engineering role.</p>",
    })), context);
    expect(result.status).toBe("succeeded");
    expect(result.structured.locations).toMatchObject({ state: "known", values: [{ countryCode: "TW" }] });
    expect(result.evidence.some((item) => item.fieldPath === "locations")).toBe(true);
  });

  it("falls back to a complete ATS detail HTML page without inventing absent facts", async () => {
    const html = `<html><head><title>採用情報</title></head><body><main><h1>人事・採用担当</h1>
      <section><h2>仕事内容</h2><p>採用計画、候補者対応、入社手続きを担当します。</p>
      <h2>応募条件</h2><p>雇用形態：正社員。人事の実務経験3年以上。日本語N1。</p></section></main></body></html>`;
    const result = await new DeterministicJobParser().parse(version(html), context);
    expect(result.status).toBe("succeeded");
    expect(result.structured).toMatchObject({ title: "人事・採用担当", employmentTypes: { state: "known" },
      languages: { state: "known" }, visaSupport: { state: "unknown" } });
    expect(result.structured.experienceRequirements).toMatchObject({ state: "known", values: [{ minimumYears: 3 }] });
  });

  it("parses Talentio detail props when the visible body is client-rendered", async () => {
    const props = JSON.stringify({ recruitmentOpenPage: { name: "Process Engineer", requisitionDetails: [
      { name: "Qualifications", value: "At least 5 years of experience. English business level. Japanese N2 or above." },
      { name: "Salary", value: "￥400K- ￥540K/Month" },
      { name: "Location", value: ["東京都江東区"] },
      { name: "Employment", value: "正社員" },
    ], jobDescriptionDetails: [] } });
    const result = await new DeterministicJobParser().parse(version(
      `<html><head><title>Process Engineer</title></head><body><div data-react-props='${props.replaceAll("'", "&#39;")}'></div></body></html>`), context);
    expect(result.status).toBe("succeeded");
    expect(result.structured).toMatchObject({ title: "Process Engineer", employmentTypes: { state: "known" },
      locations: { state: "known" }, languages: { state: "known" }, compensation: { state: "known" } });
  });
});
