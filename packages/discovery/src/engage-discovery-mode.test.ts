import { describe, expect, it } from "vitest";
import { engageEntryAction, parseEngageDiscoveryMode } from "./engage-discovery-mode.js";

describe("Engage discovery mode", () => {
  it("defaults to active and accepts pause_new", () => {
    expect(parseEngageDiscoveryMode(undefined)).toBe("active");
    expect(parseEngageDiscoveryMode("pause_new")).toBe("pause_new");
  });

  it("fails closed for misspelled modes", () => {
    expect(() => parseEngageDiscoveryMode("paused")).toThrow(/active or pause_new/);
  });

  it("never fetches a new detail while pause_new is active", () => {
    expect(engageEntryAction("pause_new", true)).toBe("observe_existing");
    expect(engageEntryAction("pause_new", false)).toBe("ignore_new");
    expect(engageEntryAction("active", false)).toBe("fetch_detail");
  });
});
