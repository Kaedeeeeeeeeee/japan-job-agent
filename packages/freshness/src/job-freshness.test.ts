import { describe, expect, it } from "vitest";
import {
  evaluatePublicationFreshness,
  evaluatePublicationLookback,
  addCalendarMonths,
  parsePublishedDateValue,
  subtractCalendarDays,
  subtractCalendarMonths,
  tokyoCalendarDate,
} from "./job-freshness.js";

describe("job freshness policy", () => {
  const now = new Date("2026-07-17T03:00:00.000Z");

  it("uses six calendar months in Tokyo rather than a fixed day count", () => {
    expect(subtractCalendarMonths("2026-07-17", 6)).toBe("2026-01-17");
    expect(subtractCalendarMonths("2026-08-31", 6)).toBe("2026-02-28");
    expect(addCalendarMonths("2026-08-31", 6)).toBe("2027-02-28");
    expect(tokyoCalendarDate(new Date("2026-07-16T15:30:00.000Z"))).toBe("2026-07-17");
    expect(subtractCalendarDays("2026-07-17", 30)).toBe("2026-06-17");
  });

  it("supports a strict one-time publication lookback window", () => {
    expect(evaluatePublicationLookback({ value: "2026-06-17", precision: "date" }, 30, now)).toMatchObject({
      eligible: true,
      cutoffDate: "2026-06-17",
      today: "2026-07-17",
    });
    expect(evaluatePublicationLookback({ value: "2026-06-16", precision: "date" }, 30, now).reason)
      .toBe("published_before_lookback_window");
    expect(evaluatePublicationLookback(undefined, 30, now).reason).toBe("publication_date_unknown");
    expect(evaluatePublicationLookback({ value: "2026-07-18", precision: "date" }, 30, now).reason)
      .toBe("published_in_future");
  });

  it("admits only dates from the inclusive six-month window", () => {
    expect(evaluatePublicationFreshness({ value: "2026-01-17", precision: "date" }, now, now).freshness).toBe("recent");
    expect(evaluatePublicationFreshness({ value: "2026-01-16", precision: "date" }, now, now)).toMatchObject({
      freshness: "expired",
      reason: "published_older_than_retention_window",
    });
  });

  it("quarantines unknown dates for seven days and rejects future dates", () => {
    expect(evaluatePublicationFreshness(undefined, now, now)).toMatchObject({
      freshness: "unknown_quarantine",
      quarantineUntil: "2026-07-24T03:00:00.000Z",
    });
    expect(evaluatePublicationFreshness({ value: "2026-07-18", precision: "date" }, now, now).reason)
      .toBe("published_in_future");
    expect(evaluatePublicationFreshness(undefined, now, new Date("2026-07-24T03:00:00.000Z"))).toMatchObject({
      freshness: "expired",
      reason: "publication_date_unknown_after_grace",
    });
  });

  it("parses trustworthy ISO, slash, dot, and Japanese publication dates", () => {
    expect(parsePublishedDateValue("掲載日：2026年7月7日")).toEqual({ value: "2026-07-07", precision: "date" });
    expect(parsePublishedDateValue("2026/7/7")).toEqual({ value: "2026-07-07", precision: "date" });
    expect(parsePublishedDateValue("publishedAt: 2026.07.07")).toEqual({ value: "2026-07-07", precision: "date" });
    expect(parsePublishedDateValue("2026-07-01T09:00:00+09:00")).toEqual({
      value: "2026-07-01T00:00:00.000Z",
      precision: "datetime",
    });
    expect(parsePublishedDateValue("not a date")).toBeUndefined();
  });
});
