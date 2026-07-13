import { proxyActivities } from "@temporalio/workflow";
import type { runSourcePipelineActivity } from "../../worker/src/activities.js";

const { runSourcePipelineActivity: runPipeline } = proxyActivities<{
  runSourcePipelineActivity: typeof runSourcePipelineActivity;
}>({
  startToCloseTimeout: "30 minutes",
  retry: { initialInterval: "5 seconds", backoffCoefficient: 2, maximumInterval: "2 minutes", maximumAttempts: 8 },
});

export interface SourceSyncWorkflowInput {
  sourceInstanceId: string;
}

export async function sourceSyncWorkflow(input: SourceSyncWorkflowInput) {
  return runPipeline(input);
}
