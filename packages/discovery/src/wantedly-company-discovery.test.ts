import { describe, expect, it } from "vitest";
import { parseWantedlyCompanyPage, wantedlyRobotsAllowsCompanyProjects } from "./wantedly-company-discovery.js";

const sourceId = "11111111-1111-4111-8111-111111111111";

describe("Wantedly public company discovery", () => {
  it("extracts exact dated normal projects and excludes meetups", () => {
    const payload = { body: { company: { name: "Acme", company_path: "/companies/acme", project_count: 2 }, projects: [
      { id: 123, category: "normal", title: "AI Engineer", published_at: "2026-07-17T19:13:13.522+09:00",
        location: "東京都", project_url: "https://www.wantedly.com/projects/123", localized_occupation_type: "エンジニア" },
      { id: 456, category: "meetup", title: "Meetup", published_at: "2026-07-18T10:00:00+09:00",
        location: "東京都", project_url: "https://www.wantedly.com/projects/456" },
    ] } };
    const result = parseWantedlyCompanyPage(bytes(`<script id="ssr-app-data" type="application/json">${JSON.stringify(payload)}</script>`),
      { tenantKey: "acme" }, sourceId, "https://www.wantedly.com/companies/acme/projects", "2026-07-18T00:00:00.000Z");
    expect(result).toMatchObject({ companyName: "Acme", projectCount: 2, normalProjectCount: 1 });
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]).toMatchObject({ externalPostingId: "123", sourceFamily: "wantedly",
      published: { value: "2026-07-17T10:13:13.522Z", precision: "datetime" } });
  });

  it("requires a complete SSR collection", () => {
    const payload = { body: { company: { name: "Acme", company_path: "/companies/acme", project_count: 2 }, projects: [] } };
    expect(() => parseWantedlyCompanyPage(bytes(`<script id="ssr-app-data">${JSON.stringify(payload)}</script>`),
      { tenantKey: "acme" }, sourceId, "https://www.wantedly.com/companies/acme/projects", "2026-07-18T00:00:00Z"))
      .toThrow("page was incomplete");
  });

  it("honors the current wildcard robots group and fails closed outside company project pages", () => {
    const robots = bytes("User-agent: *\nDisallow: /enterprise/\nDisallow: /companies/private/*\nAllow: /companies/private/projects\n");
    expect(wantedlyRobotsAllowsCompanyProjects(robots, "/companies/acme/projects")).toBe(true);
    expect(wantedlyRobotsAllowsCompanyProjects(robots, "/companies/private/projects")).toBe(true);
    expect(wantedlyRobotsAllowsCompanyProjects(robots, "/companies/private/secrets")).toBe(false);
  });
});

function bytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
