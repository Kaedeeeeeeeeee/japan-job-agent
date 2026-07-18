import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SourceInstanceRef } from "../../contracts/src/index.js";
import { WorkdayConnector, workdayTenantKey } from "./workday-connector.js";

const source: SourceInstanceRef = {
  id: randomUUID(),
  sourceKind: "workday",
  tenantKey: "sonyglobal.wd1.myworkdayjobs.com/SonyJapanCareers",
  baseUrl: "https://sonyglobal.wd1.myworkdayjobs.com/en-US/SonyJapanCareers",
};

describe("WorkdayConnector", () => {
  it("paginates the CXS collection and fetches exact job details", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/jobs")) {
        expect(init?.method).toBe("POST");
        const request = JSON.parse(String(init?.body)) as { offset: number; limit: number };
        expect(request.limit).toBe(20);
        return json({ total: request.offset === 0 ? 21 : 0, jobPostings: request.offset === 0
          ? Array.from({ length: 20 }, (_, index) => ({
            title: `Tokyo Role ${index}`,
            externalPath: `/job/Tokyo/Tokyo-Role-${index}_JR-${index}`,
            locationsText: "Tokyo",
            bulletFields: [`JR-${index}`],
          }))
          : [{ title: "Final Role", externalPath: "/job/Tokyo/Final-Role_JR-20-1", locationsText: "Tokyo",
            bulletFields: ["JR-20"] }] });
      }
      return json({ hiringOrganization: { name: "Sony Group Corporation" }, jobPostingInfo: {
        title: "Tokyo Role 0",
        jobReqId: "JR-0",
        location: "Tokyo - Osaki",
        timeType: "Full time",
        startDate: "2026-07-16",
        jobDescription: "<p>Build machine learning systems in Tokyo.</p>",
        externalUrl: "https://sonyglobal.wd1.myworkdayjobs.com/SonyJapanCareers/job/Tokyo/Tokyo-Role-0_JR-0",
      } });
    });
    const connector = new WorkdayConnector(fetcher);
    const first = await connector.fetchCollectionPage({ source, signal: AbortSignal.timeout(1_000) });
    expect(first).toMatchObject({ isLastPage: false, nextCursor: "20:21", providerTotal: 21 });
    expect(first.jobs[0]?.identity).toMatchObject({ stableKey: "JR-0",
      canonicalUrl: "https://sonyglobal.wd1.myworkdayjobs.com/en-US/SonyJapanCareers/job/Tokyo/Tokyo-Role-0_JR-0" });
    const second = await connector.fetchCollectionPage({ source, cursor: "20:21", signal: AbortSignal.timeout(1_000) });
    expect(second).toMatchObject({ isLastPage: true, providerTotal: 21 });
    const detail = await connector.fetchRecord(first.jobs[0]!.identity, AbortSignal.timeout(1_000));
    expect(detail.identity).toMatchObject({ stableKey: "JR-0", externalId: "JR-0" });
    expect(detail.exactRecordResponse).toBe(true);
    expect(new TextDecoder().decode(detail.raw)).toContain('"startDate":"2026-07-16"');
  });

  it("rejects non-Workday hosts before making a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const connector = new WorkdayConnector(fetcher);
    await expect(connector.fetchCollectionPage({ source: { ...source, baseUrl: "https://example.com/jobs" },
      signal: AbortSignal.timeout(1_000) })).rejects.toMatchObject({ code: "forbidden" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("derives a career-site-specific tenant key", () => {
    expect(workdayTenantKey(source.baseUrl)).toBe("sonyglobal.wd1.myworkdayjobs.com/SonyJapanCareers");
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: {
    "content-type": "application/json",
    "x-wd-request-id": "test-request",
  } });
}
