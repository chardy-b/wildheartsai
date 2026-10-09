import { describe, expect, it, vi } from "vitest";
import { IggyRunDispatcher, runDispatchLoop } from "../src/dispatcher.js";
import type { ClaimedWebRun } from "../src/contracts.js";

const run: ClaimedWebRun = {
  id: "20000000-0000-4000-8000-000000000001",
  attempt: 1,
  leaseOwner: "worker-test",
  deadlineAt: "2026-10-08T20:00:00.000Z",
  leaseExpiresAt: "2026-10-08T19:56:00.000Z",
  executionGrant: `whchat1.execution.${"e".repeat(43)}`,
  controlGrant: `whchat1.control.${"c".repeat(43)}`,
};

describe("remote run dispatcher", () => {
  it("sends execution grants to Iggy and keeps control grants on the coordinator", async () => {
    const iggyStarts: unknown[] = [];
    const iggyCancels: string[] = [];
    const heartbeats: string[] = [];
    const finalizations: Array<{ grant: string; value: unknown }> = [];
    const api = {
      claim: vi.fn(async (input: { requestId: string; workerId: string }) => ({ run: { ...run } })),
      heartbeat: vi.fn(async (grant: string) => { heartbeats.push(grant); return { active: false, cancelled: true, deadlineAt: run.deadlineAt }; }),
      finalize: vi.fn(async (grant: string, value: unknown) => { finalizations.push({ grant, value }); return { status: "accepted" as const }; }),
    };
    const iggy = {
      startHealthRun: async (value: unknown) => { iggyStarts.push(value); },
      cancelHealthRun: async (id: string) => { iggyCancels.push(id); },
      getHealthRunStatus: async () => "running" as const,
    };
    const dispatcher = new IggyRunDispatcher(api, iggy, "worker-test", { monitorPollMs: 100, sleep: async () => undefined });
    await expect(dispatcher.dispatchOnce()).resolves.toBe(true);
    expect(api.claim.mock.calls[0]?.[0]).toMatchObject({ workerId: "worker-test" });
    expect(iggyStarts).toEqual([{ id: run.id, capability: run.executionGrant }]);
    expect(heartbeats).toEqual([run.controlGrant]);
    expect(iggyCancels).toEqual([run.id]);
    expect(finalizations).toEqual([{ grant: run.controlGrant, value: expect.objectContaining({ status: "cancelled" }) }]);
  });

  it("uses bounded jittered backoff while claims are idle", async () => {
    const delays: number[] = [];
    const controller = new AbortController();
    let attempts = 0;
    await runDispatchLoop({ dispatchOnce: async () => { attempts += 1; return false; } }, controller.signal, {
      minIdleMs: 20,
      maxIdleMs: 30_000,
      random: () => 0.9,
      sleep: async (ms) => { delays.push(ms); if (delays.length === 3) controller.abort(); },
    });
    expect(attempts).toBe(3);
    expect(delays).toEqual([19_000, 28_000, 28_000]);
    expect(delays.every((delay) => delay <= 30_000)).toBe(true);
  });

  it("leaves web-terminal successful completion untouched", async () => {
    const finalizations: unknown[] = [];
    const api = {
      claim: async () => ({ run: { ...run } }),
      heartbeat: async () => ({ active: false, cancelled: false, deadlineAt: run.deadlineAt }),
      finalize: async (_grant: string, value: unknown) => { finalizations.push(value); return { status: "accepted" as const }; },
    };
    const iggy = {
      startHealthRun: async () => undefined,
      cancelHealthRun: async () => undefined,
      getHealthRunStatus: async () => "completed" as const,
    };
    const dispatcher = new IggyRunDispatcher(api, iggy, "worker-test", { monitorPollMs: 100, sleep: async () => undefined });
    await expect(dispatcher.dispatchOnce()).resolves.toBe(true);
    expect(finalizations).toEqual([]);
  });

  it("marks a worker exit without a web terminal event as interrupted", async () => {
    const finalizations: unknown[] = [];
    const api = {
      claim: async () => ({ run: { ...run } }),
      heartbeat: async () => ({ active: true, cancelled: false, deadlineAt: run.deadlineAt }),
      finalize: async (_grant: string, value: unknown) => { finalizations.push(value); return { status: "accepted" as const }; },
    };
    const iggy = {
      startHealthRun: async () => undefined,
      cancelHealthRun: async () => undefined,
      getHealthRunStatus: async () => "completed" as const,
    };
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(run.deadlineAt) - 1_000);
    try {
      const dispatcher = new IggyRunDispatcher(api, iggy, "worker-test", { monitorPollMs: 100, sleep: async () => undefined });
      await expect(dispatcher.dispatchOnce()).resolves.toBe(true);
      expect(finalizations).toEqual([expect.objectContaining({ status: "interrupted", errorCode: "coordinator_stopped" })]);
    } finally { clock.mockRestore(); }
  });

  it("cancels an ambiguously started run before finalizing the claim", async () => {
    const order: string[] = [];
    const api = {
      claim: async () => ({ run: { ...run } }),
      heartbeat: async () => ({ active: true, cancelled: false, deadlineAt: run.deadlineAt }),
      finalize: async () => { order.push("finalize"); return { status: "accepted" as const }; },
    };
    const iggy = {
      startHealthRun: async () => { throw new Error("lost start response"); },
      cancelHealthRun: async () => { order.push("cancel"); },
      getHealthRunStatus: async () => "failed" as const,
    };
    const dispatcher = new IggyRunDispatcher(api, iggy, "worker-test");
    await expect(dispatcher.dispatchOnce()).resolves.toBe(true);
    expect(order).toEqual(["cancel", "finalize"]);
  });

  it("increments idle backoff once for a failed claim attempt", async () => {
    const delays: number[] = [];
    const controller = new AbortController();
    let attempts = 0;
    await runDispatchLoop({ dispatchOnce: async () => { attempts += 1; throw new Error("synthetic outage"); } }, controller.signal, {
      minIdleMs: 20,
      maxIdleMs: 30_000,
      random: () => 0.9,
      sleep: async (ms) => { delays.push(ms); if (delays.length === 2) controller.abort(); },
    });
    expect(attempts).toBe(2);
    expect(delays).toEqual([19_000, 28_000]);
  });

  it("honors bounded HTTP rate-limit backoff in the coordinator loop", async () => {
    const delays: number[] = [];
    const controller = new AbortController();
    await runDispatchLoop({ dispatchOnce: async () => { throw Object.assign(new Error("rate limited"), { retryAfterMs: 25_000 }); } }, controller.signal, {
      random: () => 0,
      sleep: async (ms) => { delays.push(ms); controller.abort(); },
    });
    expect(delays).toEqual([25_000]);
  });
});
