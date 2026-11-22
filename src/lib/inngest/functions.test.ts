import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/inngest/client", () => ({
  inngest: { createFunction: (config: unknown, handler: unknown) => ({ config, handler }) },
  syncRequested: {}, directoryRefreshRequested: {}, tokenResealRequested: {},
}));
vi.mock("@/lib/epic/token-roll", () => ({ resealConnectionTokens: vi.fn(async () => ({ epic: { resealed: 1, failed: 0 }, metriport: { resealed: 0, failed: 0 }, incomplete: 0 })) }));
const envState = vi.hoisted(() => ({ next: undefined as string | undefined }));
vi.mock("@/lib/env", () => ({ env: () => ({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"), TOKEN_ENCRYPTION_KEY_NEXT: envState.next }) }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/epic/directory-import", () => ({ importEpicDirectory: vi.fn() }));
vi.mock("@/lib/sync/job", () => ({ runSyncJob: vi.fn() }));
vi.mock("@/lib/sync/run", () => ({ failRun: vi.fn() }));
vi.mock("@/lib/sync/scheduled", () => ({ sourcesDueForRefresh: vi.fn(), queueScheduledRefreshes: vi.fn() }));
vi.mock("@/lib/sync/server", () => ({ loadSyncJob: vi.fn(), prepareSyncJob: vi.fn(), sendSyncRequest: vi.fn(), startSyncJob: vi.fn() }));
vi.mock("@/lib/chat-web/runtime", () => ({ chatEnabled: vi.fn(), webChatRuntime: vi.fn() }));
vi.mock("@/lib/sync/schedule-history", () => ({ beginSchedule: vi.fn(), finishSchedule: vi.fn(), failSchedule: vi.fn() }));

import { refreshSources, resealConnectionTokensJob } from "./functions";
import { resealConnectionTokens } from "@/lib/epic/token-roll";
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

describe("token key roll backfill", () => {
  const job = resealConnectionTokensJob as unknown as { handler: (context: { step: { run: (id: string, work: () => unknown) => Promise<unknown> } }) => Promise<unknown> };
  const step = { run: async (_id: string, work: () => unknown) => work() };

  it("refuses without the next key, and never retries that", async () => {
    envState.next = undefined;
    await expect(job.handler({ step })).rejects.toThrow("TOKEN_ENCRYPTION_KEY_NEXT isn't set");
    expect(resealConnectionTokens).not.toHaveBeenCalled();
  });

  it("re-seals under the next key and answers counts only", async () => {
    envState.next = Buffer.alloc(32, 2).toString("base64");
    expect(await job.handler({ step })).toEqual({ epic: { resealed: 1, failed: 0 }, metriport: { resealed: 0, failed: 0 }, incomplete: 0 });
    const [, current, next] = vi.mocked(resealConnectionTokens).mock.calls[0];
    expect([current, next]).toEqual([Buffer.alloc(32, 1), Buffer.alloc(32, 2)]);
  });
});
