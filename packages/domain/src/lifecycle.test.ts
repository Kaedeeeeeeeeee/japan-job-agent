import { describe, expect, it } from "vitest";
import type { FinalizedSnapshot, SourceInstanceRef } from "../../contracts/src/index.js";
import { applySnapshotAbsence, type JobObservationState } from "./lifecycle.js";

const source: SourceInstanceRef = {
  id: "11111111-1111-4111-8111-111111111111",
  sourceKind: "greenhouse",
  tenantKey: "fixture",
  baseUrl: "https://example.com",
};

function snapshot(kind: FinalizedSnapshot["kind"]): FinalizedSnapshot {
  return {
    kind,
    source,
    jobs: [],
    pageCount: 1,
    finalizedAt: "2026-07-13T00:00:00.000Z",
    validation: {
      allPagesCompleted: kind === "authoritative",
      parseErrors: [],
      tenantIdentityConsistent: true,
      providerTotalMatched: true,
      circuitBreakerReasons: [],
    },
  };
}

describe("absence lifecycle", () => {
  const initial: JobObservationState = {
    stableKey: "job-1",
    state: "active",
    missingCount: 0,
    lastMissingCountedAt: null,
  };
  const policy = { requiredMissingCount: 2, minimumMissingIntervalMs: 12 * 60 * 60 * 1_000 };

  it("ignores all non-authoritative snapshots", () => {
    expect(applySnapshotAbsence(snapshot("partial"), [initial], new Date(), policy)).toEqual([initial]);
    expect(applySnapshotAbsence(snapshot("single_record"), [initial], new Date(), policy)).toEqual([initial]);
  });

  it("does not increment twice before the minimum interval", () => {
    const first = applySnapshotAbsence(snapshot("authoritative"), [initial], new Date("2026-07-13T00:00:00Z"), policy);
    const early = applySnapshotAbsence(snapshot("authoritative"), first, new Date("2026-07-13T01:00:00Z"), policy);
    expect(early[0]).toMatchObject({ missingCount: 1, state: "suspect" });
  });

  it("closes on the required missing observation after the interval", () => {
    const first = applySnapshotAbsence(snapshot("authoritative"), [initial], new Date("2026-07-13T00:00:00Z"), policy);
    const second = applySnapshotAbsence(snapshot("authoritative"), first, new Date("2026-07-13T12:00:00Z"), policy);
    expect(second[0]).toMatchObject({ missingCount: 2, state: "closed" });
  });

  it("produces zero false closures for a circuit-broken partial snapshot", () => {
    const alreadySuspect = { ...initial, state: "suspect" as const, missingCount: 1 };
    const result = applySnapshotAbsence(snapshot("partial"), [alreadySuspect], new Date("2026-07-14T00:00:00Z"), policy);
    expect(result[0]).toEqual(alreadySuspect);
  });
});
