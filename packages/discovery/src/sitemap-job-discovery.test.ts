import { describe, expect, it } from "vitest";
import {
  parseEngageDetail,
  parseSitemapEntries,
  parseSitemapIndex,
  parseTalentioDetail,
  parseYoloListingPage,
} from "./sitemap-job-discovery.js";

const sourceId = "00000000-0000-4000-8000-000000000001";
const observedAt = "2026-07-15T00:00:00.000Z";

describe("sitemap job discovery", () => {
  it("accepts only the expected sitemap host", () => {
    const xml = bytes(`<?xml version="1.0"?><urlset>
      <url><loc>https://open.talentio.com/r/1/c/example/pages/42</loc><lastmod>2026-07-14</lastmod></url>
      <url><loc>https://evil.example/r/1/c/example/pages/43</loc></url>
    </urlset>`);
    expect(parseSitemapEntries(xml, "open.talentio.com")).toEqual([{
      url: "https://open.talentio.com/r/1/c/example/pages/42", lastModified: "2026-07-14",
    }]);
    expect(parseSitemapIndex(bytes(`<sitemapindex><sitemap><loc>https://en-gage.net/jobs.xml.gz</loc></sitemap>
      <sitemap><loc>https://evil.example/jobs.xml.gz</loc></sitemap></sitemapindex>`), "en-gage.net"))
      .toEqual(["https://en-gage.net/jobs.xml.gz"]);
  });

  it("turns YOLO listing JSON-LD into a Japan lead and preserves pagination", () => {
    const page = parseYoloListingPage(bytes(`<html><body><ul><li><script type="application/ld+json">${JSON.stringify(jobPosting({
      url: "https://www.yolo-japan.com/ja/recruit/job/details/36206",
      title: "EC product engineer",
      company: "Example 株式会社",
      datePosted: "2026-07-14",
    }))}</script></li></ul><nav class="pagination"><a href="/ja/sitemap/job-category/60/2">2</a></nav></body></html>`),
    sourceId, "https://www.yolo-japan.com/ja/sitemap/job-category/60", observedAt);
    expect(page.leads).toHaveLength(1);
    expect(page.leads[0]).toMatchObject({ sourceFamily: "yolo_japan", externalPostingId: "36206",
      locationText: "JP / 東京都 / 港区", priority: "p0", published: { value: "2026-07-14", precision: "date" } });
    expect(page.nextPageUrls).toEqual(["https://www.yolo-japan.com/ja/sitemap/job-category/60/2"]);
  });

  it("keeps engage as a two-observation aggregator lead", () => {
    const detailUrl = "https://en-gage.net/user/search/desc/17503744/";
    const lead = parseEngageDetail(bytes(`<script type="application/ld+json">${JSON.stringify(jobPosting({
      url: detailUrl, title: "採用コンサルタント", company: "人事株式会社", datePosted: "2026-07-10T16:13:02+09:00",
    }))}</script>`), sourceId, detailUrl, "https://en-gage.net/sitemap_user_job_0036.xml.gz", "2026-07-14", observedAt);
    expect(lead).toMatchObject({ originKind: "aggregator_lead", sourceFamily: "engage", externalPostingId: "17503744",
      authoritative: false, priority: "p1", published: { precision: "datetime" } });
  });

  it("parses a Talentio job independently and admits only an explicit Japan location", async () => {
    const props = {
      openAtsCompany: { openAtsLinkUrl: "https://example.co.jp/" },
      recruitmentOpenPage: {
        name: "Webアプリケーションエンジニア",
        requisitionDetails: [
          { name: "勤務地", value: ["東京都 港区 JP"] },
          { name: "仕事内容", value: ["TypeScript と React を使って日本向けのプロダクトを開発する十分に長い仕事内容です。"] },
        ],
        jobDescriptionDetails: [],
        publishedAt: "2026-07-10",
      },
    };
    const raw = `<html><head><meta property="og:title" content="募集詳細 / Example株式会社"></head><body>
      <div data-react-props="${escapeAttribute(JSON.stringify(props))}"></div></body></html>`;
    const lead = await parseTalentioDetail(bytes(raw), sourceId,
      "https://open.talentio.com/r/1/c/example/pages/42", "2026-07-14", observedAt);
    expect(lead).toMatchObject({ originKind: "official_collection", sourceKindHint: "talentio", tenantKey: "example",
      externalPostingId: "42", companyName: "Example株式会社", locationText: "東京都 港区 JP", authoritative: true,
      responseMetadata: { companyUrl: "https://example.co.jp/", homeUrl: null } });
  });
});

function jobPosting(input: { url: string; title: string; company: string; datePosted: string }): Record<string, unknown> {
  return { "@context": "https://schema.org", "@type": "JobPosting", title: input.title,
    description: "日本で勤務する現在募集中の求人です。応募条件と仕事内容を確認してください。",
    hiringOrganization: { "@type": "Organization", name: input.company },
    jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressCountry: "JP",
      addressRegion: "東京都", addressLocality: "港区" } }, datePosted: input.datePosted, url: input.url };
}

function bytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function escapeAttribute(value: string): string { return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;"); }
