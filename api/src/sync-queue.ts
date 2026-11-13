import type { SyncRequest } from "./data/sync-runs";
import type { Bindings } from "./env";

// Starts the sync Workflow for a queued run (ids only). The run id is the instance id, so a run
// can't be started twice.
export function sendTo(env: Bindings) {
  return async (request: SyncRequest): Promise<void> => {
    await env.SYNC_WORKFLOW.create({ id: request.runId, params: request });
  };
}
