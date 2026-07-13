export type RefreshIneligibleReason =
  | "job_inactive"
  | "save_or_apply_required"
  | "source_unverified"
  | "source_not_refreshable"
  | "source_not_stale";

export interface RefreshPolicyInput {
  lifecycleState: "active" | "suspect" | "closed";
  saved: boolean;
  applied: boolean;
  sourceVerified: boolean;
  sourceKind: string;
  staleRefreshAllowed: boolean;
  fetchedAt: Date;
  intervalHours: number;
  now: Date;
}

export interface RefreshPolicyResult {
  eligible: boolean;
  stale: boolean;
  reason: RefreshIneligibleReason | null;
  staleAt: string;
}

export function evaluateRefreshPolicy(input: RefreshPolicyInput): RefreshPolicyResult {
  const staleAtDate = new Date(input.fetchedAt.getTime() + input.intervalHours * 60 * 60 * 1_000);
  const stale = input.now.getTime() >= staleAtDate.getTime();
  const base = { stale, staleAt: staleAtDate.toISOString() };
  if (input.lifecycleState !== "active") return { ...base, eligible: false, reason: "job_inactive" };
  if (!input.saved && !input.applied) return { ...base, eligible: false, reason: "save_or_apply_required" };
  if (!input.sourceVerified) return { ...base, eligible: false, reason: "source_unverified" };
  if (!input.staleRefreshAllowed || !["greenhouse", "schema_org"].includes(input.sourceKind)) {
    return { ...base, eligible: false, reason: "source_not_refreshable" };
  }
  if (!stale) return { ...base, eligible: false, reason: "source_not_stale" };
  return { ...base, eligible: true, reason: null };
}
