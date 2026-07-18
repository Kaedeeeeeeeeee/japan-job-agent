import { describe, expect, it } from "vitest";
import { candidatesFromText, deduplicateArtifactCandidates, githubTenantQueries, matchCompanyNameSignal } from "./tenant-artifact.js";

describe("source tenant artifact", () => {
  it("shards GitHub queries without exceeding the configured 300-request design ceiling", () => {
    const queries = githubTenantQueries();
    expect(queries.length).toBeGreaterThan(8);
    expect(queries.length).toBeLessThanOrEqual(30);
    expect(new Set(queries).size).toBe(queries.length);
    expect(queries.some((query) => query.includes("myworkdayjobs.com"))).toBe(true);
    expect(queries.some((query) => query.includes("greenhouse.io"))).toBe(true);
  });

  it("extracts all supported tenant URL families and ignores unrelated links", () => {
    const input = [
      "https://boards.greenhouse.io/acme/jobs/123",
      "https://sony.wd1.myworkdayjobs.com/en-US/Japan/job/Tokyo/Engineer_JR1",
      "https://jobs.smartrecruiters.com/acme/123-engineer",
      "https://jobs.lever.co/acme/abc",
      "https://jobs.ashbyhq.com/acme/11111111-1111-4111-8111-111111111111",
      "https://hrmos.co/pages/acme/jobs/123",
      "https://herp.careers/v1/acme/abc",
      "https://open.talentio.com/r/1/c/acme/pages/123",
      "https://example.com/not-an-ats",
    ].join("\n");
    const candidates = candidatesFromText(input);
    expect(new Set(candidates.map((candidate) => candidate.sourceKind))).toEqual(new Set([
      "greenhouse", "workday", "smartrecruiters", "lever", "ashby", "hrmos", "herp", "talentio",
    ]));
  });

  it("deduplicates by kind and tenant while retaining a permitted repository homepage reference", () => {
    const first = candidatesFromText("https://jobs.ashbyhq.com/acme/one");
    const second = candidatesFromText("https://jobs.ashbyhq.com/acme/two", {
      repositoryHomepage: "https://www.acme.example/careers",
    });
    const deduplicated = deduplicateArtifactCandidates([...first, ...second]);
    expect(deduplicated).toHaveLength(1);
    expect(deduplicated[0]).toMatchObject({ tenantKey: "acme",
      officialReferrerUrl: "https://www.acme.example/careers", officialReferrerBasis: "repository_homepage" });
  });

  it("uses JPX names only as normalized ranking signals", () => {
    expect(matchCompanyNameSignal("careers for Example Corporation Japan", ["Other Ltd.", "Example Corporation"])).toBe(
      "Example Corporation",
    );
    expect(matchCompanyNameSignal("unrelated repository", ["Example Corporation"])).toBeUndefined();
  });
});
