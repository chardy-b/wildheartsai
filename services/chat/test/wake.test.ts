import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinatorWake, createCoordinatorWakeServer } from "../src/wake.js";
import { runDispatchLoop } from "../src/dispatcher.js";

const secret = `whwake1.${"w".repeat(43)}`;
afterEach(() => vi.useRealTimers());

// Vitest controls global timers, whereas node:timers/promises uses real timers.
function clockSleep(signal: AbortSignal) {
  return (ms: number) => new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

describe("notification-driven coordinator", () => {
  it("claims at startup, sleeps through idle time, and wakes for work without a lost-wake race", async () => {
    vi.useFakeTimers();
    const wake = new CoordinatorWake();
    const stop = new AbortController();
    const claim = vi.fn(async () => false);
    const loop = runDispatchLoop({ dispatchOnce: claim }, stop.signal, { wake, sleep: clockSleep(stop.signal) });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(claim).toHaveBeenCalledTimes(1);
    wake.notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(claim).toHaveBeenCalledTimes(2);
    // A notification in the ten-second claim cooldown must remain pending.
    wake.notify();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(claim).toHaveBeenCalledTimes(3);
    stop.abort();
    await loop;
  });

  it("recovers a missed notification with a five-minute check", async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const claim = vi.fn(async () => false);
    const loop = runDispatchLoop({ dispatchOnce: claim }, stop.signal, { wake: new CoordinatorWake(), sleep: clockSleep(stop.signal) });
    await vi.advanceTimersByTimeAsync(299_999);
    expect(claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(claim).toHaveBeenCalledTimes(2);
    stop.abort();
    await loop;
  });

  it("drains multiple jobs after one wake and coalesces bursts without exceeding claim limits", async () => {
    vi.useFakeTimers();
    const wake = new CoordinatorWake();
    const stop = new AbortController();
    let work = 0;
    const claim = vi.fn(async () => work > 0 ? (work--, true) : false);
    const loop = runDispatchLoop({ dispatchOnce: claim }, stop.signal, { wake, sleep: clockSleep(stop.signal) });
    await vi.advanceTimersByTimeAsync(20_000);
    work = 3;
    for (let n = 0; n < 1000; n++) wake.notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(work).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(work).toBe(0);
    expect(claim).toHaveBeenCalledTimes(5); // initial empty, three jobs, final empty
    await vi.advanceTimersByTimeAsync(120_000);
    expect(claim).toHaveBeenCalledTimes(5);
    stop.abort();
    await loop;
  });

  it("retains a wake while work is active and honors HTTP retry cooldowns", async () => {
    vi.useFakeTimers();
    const wake = new CoordinatorWake();
    const stop = new AbortController();
    let release!: () => void;
    const claim = vi.fn().mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = () => resolve(true); }))
      .mockRejectedValueOnce({ retryAfterMs: 25_000 }).mockResolvedValue(false);
    const loop = runDispatchLoop({ dispatchOnce: claim }, stop.signal, { wake, sleep: clockSleep(stop.signal) });
    wake.notify();
    await vi.advanceTimersByTimeAsync(30_000);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(claim).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(24_999);
    expect(claim).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(claim).toHaveBeenCalledTimes(3);
    stop.abort();
    await loop;
  });
});

describe("VPS wake-only ingress", () => {
  it("accepts only the separate wake credential, exact path, POST method and empty body", async () => {
    const wake = vi.fn();
    const server = createCoordinatorWakeServer(secret, wake);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const send = (path: string, method = "POST", token = secret, body?: string) => fetch(origin + path, {
      method, headers: { authorization: `Bearer ${token}`, cookie: "synthetic-user-session" }, body,
    });
    try {
      expect((await send("/internal/chat/wake")).status).toBe(204);
      expect(wake).toHaveBeenCalledOnce();
      for (const token of ["", `whchat1.execution.${"e".repeat(43)}`, `whwake1.${"x".repeat(43)}`]) {
        expect((await send("/internal/chat/wake", "POST", token)).status).toBe(401);
      }
      expect((await send("/internal/chat/wake?userId=synthetic")).status).toBe(404);
      expect((await send("/api/chat/worker/v1/claims")).status).toBe(404);
      expect((await send("/internal/chat/wake", "GET")).status).toBe(405);
      expect((await send("/internal/chat/wake", "POST", secret, '{"runId":"synthetic"}')).status).toBe(400);
      expect(wake).toHaveBeenCalledOnce();
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
