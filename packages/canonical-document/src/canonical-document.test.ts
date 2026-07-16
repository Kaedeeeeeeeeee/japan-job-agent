import { describe, expect, it } from "vitest";
import type { ParserContext, SourceJobVersion, SourceKind } from "../../contracts/src/index.js";
import { buildCanonicalDocument, canonicalSourceAdapters } from "./canonical-document.js";

function build(raw: string, sourceKind: SourceKind = "airwork") {
  const version: SourceJobVersion = {
    id: "raw-version", sourceJobRecordId: "record", rawHash: "a".repeat(64), contentHash: "b".repeat(64),
    canonicalizationVersion: "raw-v1", raw: new TextEncoder().encode(raw), sourceUrl: "https://example.com/job", fetchedAt: new Date(0).toISOString(),
  };
  const context: ParserContext = { source: { id: crypto.randomUUID(), sourceKind, tenantKey: "example", baseUrl: "https://example.com" }, localeHints: ["ja-JP"] };
  return buildCanonicalDocument(version, context);
}

describe("Canonical Document adapters", () => {
  it("registers every supported source kind", () => {
    expect([...canonicalSourceAdapters.keys()]).toEqual(expect.arrayContaining([
      "airwork", "engage", "herp", "jobcan", "talentio", "hrmos", "greenhouse", "smartrecruiters", "lever", "ashby",
    ]));
  });

  it("splits an AirWork-style page into field-specific sections with locators", () => {
    const document = build(`<!doctype html><html><body><main>
      <h1>【正社員】工具メーカーの事務スタッフ</h1>
      <section class="demand"><h2>求める人材</h2><p>事務職経験者</p><div><h3>スキル</h3><span>Microsoft Word</span><span>Microsoft Excel</span></div></section>
      <section class="store"><h2>勤務地</h2><dl><dt>住所</dt><dd>〒959-0215 新潟県燕市吉田下中野1535番地5</dd></dl></section>
      <section class="salary"><h2>給与</h2><p>月給 22万円 〜 25万円</p></section>
    </main></body></html>`);
    expect(document.title).toContain("正社員");
    expect(document.sections.some((section) => section.kind === "location" && section.text.includes("新潟県燕市"))).toBe(true);
    expect(document.sections.some((section) => section.kind === "compensation" && section.text.includes("22万円"))).toBe(true);
    expect(document.sections.some((section) => section.kind === "skills" && section.text.includes("Microsoft Excel"))).toBe(true);
    expect(document.sections.every((section) => typeof section.locator.kind === "string")).toBe(true);
  });

  it("normalizes structured public ATS JSON into the same section vocabulary", () => {
    const document = build(JSON.stringify({
      title: "Backend Engineer", employmentType: "FULL_TIME", location: { name: "Tokyo, Japan" },
      description: "Build APIs", requirements: "Japanese JLPT N2", salary: "年収 500万円〜700万円",
    }), "greenhouse");
    expect(document.sections.map((section) => section.kind)).toEqual(expect.arrayContaining([
      "title", "employment", "location", "compensation", "responsibilities", "required_requirements",
    ]));
    expect(document.sections.find((section) => section.kind === "location")?.locator.kind).toBe("json_path");
  });

  it("does not classify a company-information address as the workplace", () => {
    const document = build(`<html><body><main><h1>営業職</h1>
      <section><h2>仕事内容</h2><p>法人営業を担当します。</p></section>
      <section><h2>会社情報</h2><dl><dt>住所</dt><dd>大阪府大阪市</dd></dl></section>
    </main></body></html>`);
    expect(document.sections.some((section) => section.kind === "location")).toBe(false);
  });

  it("decodes escaped ATS HTML, removes inline media payloads, and bounds section size", () => {
    const oversized = `&lt;p&gt;${"担当業務。".repeat(2_000)}&lt;/p&gt;`
      + `&lt;img src=&quot;data:image/jpeg;base64,${"A".repeat(20_000)}&quot;&gt;`;
    const document = build(JSON.stringify({ title: "Platform Engineer", content: oversized }), "greenhouse");
    const responsibilities = document.sections.filter((section) => section.kind === "responsibilities");
    expect(responsibilities.length).toBeGreaterThan(1);
    expect(Math.max(...responsibilities.map((section) => section.text.length))).toBeLessThanOrEqual(6_000);
    expect(document.fullText).not.toContain("base64");
    expect(document.fullText).not.toContain("A".repeat(100));
  });
});
