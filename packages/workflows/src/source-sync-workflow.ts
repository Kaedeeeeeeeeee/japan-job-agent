import { proxyActivities } from "@temporalio/workflow";
import type { finalizeRefreshFailureActivity, runSourcePipelineActivity } from "../../worker/src/activities.js";

const { runSourcePipelineActivity: runPipeline } = proxyActivities<{
  runSourcePipelineActivity: typeof runSourcePipelineActivity;
}>({
  startToCloseTimeout: "30 minutes",
  retry: { initialInterval: "5 seconds", backoffCoefficient: 2, maximumInterval: "2 minutes", maximumAttempts: 8 },
});
const { finalizeRefreshFailureActivity: finalizeRefreshFailure } = proxyActivities<{
  finalizeRefreshFailureActivity: typeof finalizeRefreshFailureActivity;
}>({ startToCloseTimeout: "1 minute", retry: { maximumAttempts: 3 } });

export interface SourceSyncWorkflowInput {
  sourceInstanceId: string;
  refreshRequestId?: string;
}

export async function sourceSyncWorkflow(input: SourceSyncWorkflowInput) {
  try {
    return await runPipeline(input);
  } catch (error) {
    if (input.refreshRequestId !== undefined) {
      await finalizeRefreshFailure({
        refreshRequestId: input.refreshRequestId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}
