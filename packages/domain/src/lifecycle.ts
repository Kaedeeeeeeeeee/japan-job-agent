import type { FinalizedSnapshot } from "../../contracts/src/index.js";

export type JobLifecycleState = "active" | "suspect" | "closed";

export interface JobObservationState {
  stableKey: string;
  state: JobLifecycleState;
  missingCount: number;
  lastMissingCountedAt: Date | null;
}

export interface AbsencePolicy {
  requiredMissingCount: number;
  minimumMissingIntervalMs: number;
}

export function applySnapshotAbsence(
  snapshot: FinalizedSnapshot,
  jobs: readonly JobObservationState[],
  observedAt: Date,
  policy: AbsencePolicy,
): JobObservationState[] {
  if (snapshot.kind !== "authoritative") return jobs.map(copyState);
  const present = new Set(snapshot.jobs.map((job) => job.identity.stableKey));
  return jobs.map((job) => {
    if (present.has(job.stableKey)) {
      return { ...job, state: "active", missingCount: 0, lastMissingCountedAt: null };
    }
    const intervalPassed = job.lastMissingCountedAt === null
      || observedAt.getTime() - job.lastMissingCountedAt.getTime() >= policy.minimumMissingIntervalMs;
    if (!intervalPassed) return copyState(job);
    const missingCount = job.missingCount + 1;
    return {
      ...job,
      missingCount,
      lastMissingCountedAt: observedAt,
      state: missingCount >= policy.requiredMissingCount ? "closed" : "suspect",
    };
  });
}

function copyState(state: JobObservationState): JobObservationState {
  return { ...state };
}

