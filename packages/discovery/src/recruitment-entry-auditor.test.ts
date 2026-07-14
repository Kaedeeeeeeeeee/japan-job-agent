import { describe, expect, it } from "vitest";
import { auditRecruitmentEntrypoint, detectSource } from "./recruitment-entry-auditor.js";

describe("recruitment entrypoint audit", () => {
  it("detects supported and queued ATS families deterministically", () => {
    expect(detectSource("https://hrmos.co/pages/acme/jobs/123")).toMatchObject({ kind: "hrmos", tenantKey: "acme", collection: true });
    expect(detectSource("https://hrmos.co/pages/acme")).toMatchObject({ kind: "hrmos", tenantKey: "acme", collection: true });
    expect(detectSource("https://public.n-ats.hrmos.co/acme/jobs/123")).toMatchObject({ kind: "schema_org", collection: false });
    expect(detectSource("https://herp.careers/v1/acme/abc")).toMatchObject({ kind: "herp", tenantKey: "acme" });
    expect(detectSource("https://recruit.jobcan.jp/acme/job_offers/42")).toMatchObject({ kind: "jobcan", tenantKey: "acme" });
    expect(detectSource("https://arwrk.net/recruit/acme/123/")).toMatchObject({
      kind: "airwork", tenantKey: "acme", url: "https://arwrk.net/recruit/acme",
    });
    expect(detectSource("https://en-gage.net/acme/work_42/")).toMatchObject({ kind: "engage", tenantKey: "acme" });
    expect(detectSource("https://open.talentio.com/r/1/c/acme/homes/4042")).toMatchObject({
      kind: "talentio", tenantKey: "acme", url: "https://open.talentio.com/r/1/c/acme/homes/4042",
    });
    expect(detectSource("https://example.com/recruit")).toBeNull();
  });

  it("extracts JobPosting and ATS links without following page links", async () => {
    let calls = 0;
    const audit = await auditRecruitmentEntrypoint("https://careers.example.com/", async () => {
      calls += 1;
      return new Response(`<a href="https://hrmos.co/pages/acme/jobs">求人</a><script type="application/ld+json">
        {"@type":"JobPosting","title":"Engineer"}</script>`, { status: 200 });
    }, async () => ["203.0.113.20"], "2026-07-14T00:00:00.000Z");
    expect(calls).toBe(1);
    expect(audit.status).toBe("fetched");
    expect(audit.detectedSources.map((source) => source.kind).sort()).toEqual(["hrmos", "schema_org"]);
  });

  it("blocks a private redirect target before requesting it", async () => {
    let calls = 0;
    const audit = await auditRecruitmentEntrypoint("https://careers.example.com/", async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
    }, async () => ["203.0.113.20"]);
    expect(audit.status).toBe("blocked");
    expect(calls).toBe(1);
  });
});
