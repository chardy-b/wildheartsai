import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/inngest/client", () => ({
  inngest: { createFunction: (config: unknown, handler: unknown) => ({ config, handler }) },
  syncRequested: {}, directoryRefreshRequested: {},
}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/epic/directory-import", () => ({ importEpicDirectory: vi.fn() }));
vi.mock("@/lib/sync/job", () => ({ runSyncJob: vi.fn() }));
vi.mock("@/lib/sync/run", () => ({ failRun: vi.fn() }));
vi.mock("@/lib/sync/scheduled", () => ({ sourcesDueForRefresh: vi.fn(), queueScheduledRefreshes: vi.fn() }));
vi.mock("@/lib/sync/server", () => ({ loadSyncJob: vi.fn(), prepareSyncJob: vi.fn(), sendSyncRequest: vi.fn(), startSyncJob: vi.fn() }));
vi.mock("@/lib/chat-web/runtime", () => ({ chatEnabled: vi.fn(), webChatRuntime: vi.fn() }));
vi.mock("@/lib/sync/schedule-history", () => ({ beginSchedule: vi.fn(), finishSchedule: vi.fn(), failSchedule: vi.fn() }));

import { refreshSources } from "./functions";
import { sourcesDueForRefresh } from "@/lib/sync/scheduled";
import { beginSchedule, finishSchedule, failSchedule } from "@/lib/sync/schedule-history";

// Capture the actual SDK callbacks rather than reimplementing scheduler logic.
const scheduled = refreshSources as unknown as {
  handler: (context: { event: { name: string }; runId: string; step: { run: (id: string, work: () => unknown) => Promise<unknown> } }) => Promise<unknown>;
  config: { onFailure: (context: { event: { data: { run_id: string; event: { name: string } } } }) => Promise<void> };
};

describe("nightly refresh execution identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sourcesDueForRefresh).mockResolvedValue([]);
  });

  it("runs a real cron payload without an event ID and records its execution", async () => {
    const result = await scheduled.handler({
      event: { name: "inngest/scheduled.timer" },
      runId: "nightly-run",
      step: { run: async (_id, work) => work() },
    });
    expect(result).toEqual({ due: 0, queued: 0, skipped: 0, failed: 0 });
    expect(beginSchedule).toHaveBeenCalledWith(expect.anything(), "nightly-run", expect.any(Date));
    expect(finishSchedule).toHaveBeenCalledWith(expect.anything(), "nightly-run", result, expect.any(Date));
  });

  it("marks the original execution failed even when its cron event has no ID", async () => {
    await scheduled.config.onFailure({ event: { data: {
      run_id: "nightly-run", event: { name: "inngest/scheduled.timer" },
    } } });
    expect(failSchedule).toHaveBeenCalledWith(expect.anything(), "nightly-run", expect.any(Date));
  });
});
