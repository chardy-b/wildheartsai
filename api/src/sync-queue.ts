import type { SyncRequest } from "./data/sync-runs";
import type { Bindings } from "./env";

// Hands a sync request (ids only) to the queue the sync Workflow consumes (Phase 4).
export function sendTo(env: Bindings) {
  return async (request: SyncRequest): Promise<void> => {
    await env.SYNC_QUEUE.send(request);
  };
}
