import { describe, expect, it } from "vitest";
import { evaluateRefreshPolicy } from "./refresh-policy.js";

const now = new Date("2026-07-13T12:00:00.000Z");
const baseline = {
  lifecycleState: "active" as const,
  saved: true,
  applied: false,
  sourceVerified: true,
  sourceKind: "greenhouse",
  staleRefreshAllowed: true,
  fetchedAt: new Date("2026-07-12T23:59:59.000Z"),
  intervalHours: 12,
  now,
};

describe("restricted on-demand refresh policy", () => {
  it("allows a saved stale job from a verified refreshable source", () => {
    expect(evaluateRefreshPolicy(baseline)).toEqual({
      eligible: true,
      stale: true,
      reason: null,
      staleAt: "2026-07-13T11:59:59.000Z",
    });
  });

  it("requires saved or applied state", () => {
    expect(evaluateRefreshPolicy({ ...baseline, saved: false }).reason).toBe("save_or_apply_required");
    expect(evaluateRefreshPolicy({ ...baseline, saved: false, applied: true }).eligible).toBe(true);
  });

  it("does not refresh fresh, manual, unverified, or inactive jobs", () => {
    expect(evaluateRefreshPolicy({ ...baseline, fetchedAt: now }).reason).toBe("source_not_stale");
    expect(evaluateRefreshPolicy({ ...baseline, sourceKind: "manual" }).reason).toBe("source_not_refreshable");
    expect(evaluateRefreshPolicy({ ...baseline, sourceVerified: false }).reason).toBe("source_unverified");
    expect(evaluateRefreshPolicy({ ...baseline, lifecycleState: "suspect" }).reason).toBe("job_inactive");
  });
});
