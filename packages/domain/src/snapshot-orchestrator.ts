import type {
  CollectionPage,
  DiscoveredJob,
  FinalizedSnapshot,
  SourceConnector,
  SourceInstanceRef,
} from "../../contracts/src/index.js";

export interface SnapshotCircuitPolicy {
  allowsAuthoritativeSnapshot: boolean;
  minimumPreviousActive: number;
  maximumMissingRatio: number;
  maximumMissingAbsolute: number;
}

export interface CollectionContext {
  source: SourceInstanceRef;
  previousActiveStableKeys: ReadonlySet<string>;
  policy: SnapshotCircuitPolicy;
  now: () => Date;
  signal: AbortSignal;
}

export async function collectSnapshot(
  connector: SourceConnector,
  context: CollectionContext,
): Promise<FinalizedSnapshot> {
  const jobs = new Map<string, DiscoveredJob>();
  const parseErrors: string[] = [];
  let cursor: string | undefined;
  let pageCount = 0;
  let providerTotal: number | undefined;
  let allPagesCompleted = false;
  let tenantIdentityConsistent = true;

  try {
    do {
      const request = cursor === undefined
        ? { source: context.source, signal: context.signal }
        : { source: context.source, cursor, signal: context.signal };
      const page: CollectionPage = await connector.fetchCollectionPage(request);
      pageCount += 1;
      providerTotal ??= page.providerTotal;
      if (page.providerTotal !== undefined && providerTotal !== page.providerTotal) {
        parseErrors.push("provider total changed between pages");
      }
      for (const job of page.jobs) {
        if (job.identity.sourceInstanceId !== context.source.id) {
          tenantIdentityConsistent = false;
          continue;
        }
        jobs.set(job.identity.stableKey, job);
      }
      if (page.isLastPage) {
        allPagesCompleted = true;
        cursor = undefined;
      } else if (page.nextCursor === undefined) {
        parseErrors.push("non-final page omitted next cursor");
        cursor = undefined;
      } else {
        cursor = page.nextCursor;
      }
    } while (cursor !== undefined);
  } catch (error) {
    parseErrors.push(error instanceof Error ? error.message : String(error));
  }

  const providerTotalMatched = providerTotal === undefined || providerTotal === jobs.size;
  const circuitBreakerReasons = closureCircuitReasons(
    context.previousActiveStableKeys,
    new Set(jobs.keys()),
    context.policy,
  );
  const authoritative = context.policy.allowsAuthoritativeSnapshot
    && allPagesCompleted
    && parseErrors.length === 0
    && tenantIdentityConsistent
    && providerTotalMatched
    && circuitBreakerReasons.length === 0;

  const result: FinalizedSnapshot = {
    kind: authoritative ? "authoritative" : "partial",
    source: context.source,
    jobs: [...jobs.values()],
    pageCount,
    finalizedAt: context.now().toISOString(),
    validation: {
      allPagesCompleted,
      parseErrors,
      tenantIdentityConsistent,
      providerTotalMatched,
      circuitBreakerReasons,
    },
  };
  if (providerTotal !== undefined) result.providerTotal = providerTotal;
  return result;
}

export function finalizeSingleRecord(
  source: SourceInstanceRef,
  job: DiscoveredJob,
  now: Date,
): FinalizedSnapshot {
  return {
    kind: "single_record",
    source,
    jobs: [job],
    pageCount: 1,
    providerTotal: 1,
    finalizedAt: now.toISOString(),
    validation: {
      allPagesCompleted: true,
      parseErrors: [],
      tenantIdentityConsistent: job.identity.sourceInstanceId === source.id,
      providerTotalMatched: true,
      circuitBreakerReasons: [],
    },
  };
}

export function closureCircuitReasons(
  previous: ReadonlySet<string>,
  current: ReadonlySet<string>,
  policy: SnapshotCircuitPolicy,
): string[] {
  const missing = [...previous].filter((key) => !current.has(key)).length;
  if (missing === 0) return [];
  const ratio = previous.size === 0 ? 0 : missing / previous.size;
  const reasons: string[] = [];
  if (previous.size >= policy.minimumPreviousActive && current.size === 0) {
    reasons.push("unexpected_zero");
  }
  if (ratio > policy.maximumMissingRatio) reasons.push("missing_ratio_exceeded");
  if (missing > policy.maximumMissingAbsolute) reasons.push("missing_absolute_exceeded");
  return reasons;
}
