import { describe, expect, it } from "vitest";
import { discoveryBackfillWindow, evaluateLeadForBackfill } from "./discovery-backfill-window.js";

describe("discovery backfill publication window", () => {
  const now = new Date("2026-07-17T03:00:00.000Z");

  it("is disabled unless explicitly requested", () => {
    expect(discoveryBackfillWindow(undefined, now)).toBeNull();
  });

  it("requires an explicit publication date inside the requested window", () => {
    const window = discoveryBackfillWindow("30", now)!;
    expect(window).toMatchObject({ days: 30, cutoffDate: "2026-06-17", today: "2026-07-17" });
    expect(evaluateLeadForBackfill({ published: { value: "2026-07-01", precision: "date" } }, window)?.eligible)
      .toBe(true);
    expect(evaluateLeadForBackfill({ published: { value: "2026-06-01", precision: "date" } }, window)?.eligible)
      .toBe(false);
    expect(evaluateLeadForBackfill({}, window)?.reason).toBe("publication_date_unknown");
  });
});
