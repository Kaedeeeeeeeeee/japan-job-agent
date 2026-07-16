import { describe, expect, it } from "vitest";
import { normalizeCompensationText } from "./job-normalizers.js";

describe("job normalizers", () => {
  it("parses Japanese man-yen ranges with a remainder without reversing min/max", () => {
    expect(normalizeCompensationText("月給 23万9000円 〜 27万9000円")).toEqual([
      expect.objectContaining({ period: "month", minimumAmount: 239000, maximumAmount: 279000 }),
    ]);
  });

  it("parses plain yen ranges and the AirWork 22 to 25 man range", () => {
    expect(normalizeCompensationText("月給：259,000円～279,000円")).toEqual([
      expect.objectContaining({ minimumAmount: 259000, maximumAmount: 279000 }),
    ]);
    expect(normalizeCompensationText("月給22万円〜25万円")).toEqual([
      expect.objectContaining({ minimumAmount: 220000, maximumAmount: 250000 }),
    ]);
  });

  it("rejects malformed or descending ranges instead of persisting inverted salary facts", () => {
    expect(normalizeCompensationText("年収 6,000,000円～8000,000円")).toEqual([]);
    expect(normalizeCompensationText("月給 500,000円～300,000円")).toEqual([]);
  });
});
