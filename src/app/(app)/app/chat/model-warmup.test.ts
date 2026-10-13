import { describe, expect, it, vi } from "vitest";
import { monitorModelWarmup, parseModelWarmupSnapshot, type ModelWarmupSnapshot } from "./model-warmup";

const snapshot = (status: ModelWarmupSnapshot["status"]): ModelWarmupSnapshot => ({ status, retryAt: null, readyUntil: null });

describe("model warmup monitor", () => {
  it("starts warmup once and polls until the model is ready", async () => {
    const post = vi.fn().mockResolvedValue(snapshot("queued"));
    const get = vi.fn().mockResolvedValueOnce(snapshot("running")).mockResolvedValueOnce(snapshot("ready"));
    const onStatus = vi.fn();
    const controller = new AbortController();

    const outcome = await monitorModelWarmup({
      post,
      get,
      onStatus,
      signal: controller.signal,
      isCurrent: () => true,
      wait: async () => undefined,
      pollMs: 5,
    });

    expect(outcome).toBe("settled");
    expect(post).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(2);
    expect(onStatus.mock.calls.map(([value]) => value.status)).toEqual(["queued", "running", "ready"]);
  });

  it("stops within the bounded wait without restarting warmup", async () => {
    let time = 0;
    const post = vi.fn().mockResolvedValue(snapshot("running"));
    const get = vi.fn().mockResolvedValue(snapshot("running"));
    const controller = new AbortController();

    const outcome = await monitorModelWarmup({
      post,
      get,
      onStatus: () => undefined,
      signal: controller.signal,
      isCurrent: () => true,
      wait: async delay => { time += delay; },
      now: () => time,
      maxWaitMs: 10,
      pollMs: 5,
    });

    expect(outcome).toBe("timed-out");
    expect(post).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(time).toBe(10);
  });

  it("ignores a response after its request becomes stale", async () => {
    let current = true;
    const post = vi.fn().mockImplementation(async () => {
      current = false;
      return snapshot("queued");
    });
    const get = vi.fn();
    const onStatus = vi.fn();
    const controller = new AbortController();

    const outcome = await monitorModelWarmup({
      post,
      get,
      onStatus,
      signal: controller.signal,
      isCurrent: () => current,
      wait: async () => undefined,
    });

    expect(outcome).toBe("stale");
    expect(get).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("discards a delayed readiness result after a newer intent supersedes polling", async () => {
    let current = true;
    let resolveGet!: (value: ModelWarmupSnapshot) => void;
    let markGetStarted!: () => void;
    const getStarted = new Promise<void>(resolve => { markGetStarted = resolve; });
    const post = vi.fn().mockResolvedValue(snapshot("queued"));
    const get = vi.fn(() => {
      markGetStarted();
      return new Promise<ModelWarmupSnapshot>(resolve => { resolveGet = resolve; });
    });
    const onStatus = vi.fn();
    const controller = new AbortController();
    const monitoring = monitorModelWarmup({
      post, get, onStatus, signal: controller.signal, isCurrent: () => current,
      wait: async () => undefined,
    });
    await getStarted;
    current = false;
    resolveGet({ status: "ready", retryAt: null, readyUntil: "2026-10-11T12:05:00Z" });
    await expect(monitoring).resolves.toBe("stale");
    expect(onStatus.mock.calls.map(([value]) => value.status)).toEqual(["queued"]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed status and retry timestamps", () => {
    expect(() => parseModelWarmupSnapshot({ status: "loading" })).toThrow("invalid_warmup_response");
    expect(() => parseModelWarmupSnapshot({ status: "failed", retryAt: "tomorrow" })).toThrow("invalid_warmup_response");
    expect(() => parseModelWarmupSnapshot({ status: "ready", readyUntil: "tomorrow" })).toThrow("invalid_warmup_response");
    expect(() => parseModelWarmupSnapshot({ status: "ready" })).toThrow("invalid_warmup_response");
    expect(() => parseModelWarmupSnapshot({ status: "ready", readyUntil: null })).toThrow("invalid_warmup_response");
    expect(parseModelWarmupSnapshot({ status: "ready", readyUntil: "2026-10-11T12:05:00Z" }).readyUntil).toBe("2026-10-11T12:05:00Z");
  });
});
