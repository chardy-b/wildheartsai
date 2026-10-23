import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock("next/server", () => ({ after: mocks.after }));
import { notifyChatCoordinator, scheduleChatWake } from "./wake";

const secret = `whwake1.${"w".repeat(43)}`;
const config = { url: "https://wake.example/internal/chat/wake", secret };
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("post-commit wake notification", () => {
  it("sends only an empty authenticated hint to a fixed URL with redirects disabled", async () => {
    const send = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await notifyChatCoordinator(config, send)).toBe(true);
    expect(send).toHaveBeenCalledExactlyOnceWith(config.url, {
      method: "POST", headers: { authorization: `Bearer ${secret}` }, redirect: "error", cache: "no-store", signal: expect.any(AbortSignal),
    });
  });

  it("retries a failed hint once, without exposing errors or failing a committed job", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("private-token-canary")).mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await notifyChatCoordinator(config, send)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    send.mockRejectedValue(new Error("private-token-canary"));
    expect(await notifyChatCoordinator(config, send)).toBe(false);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("schedules delivery after the response and sanitizes background delivery failures", async () => {
    vi.stubEnv("CHAT_WAKE_URL", config.url); vi.stubEnv("CHAT_WAKE_SECRET", secret);
    const send = vi.fn().mockRejectedValue(new Error("private-url-token-canary"));
    vi.stubGlobal("fetch", send);
    scheduleChatWake();
    expect(send).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0][0]();
    expect(send).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('{"event":"chat_wake_failed","code":"delivery_failed"}');
  });

  it("does nothing without configuration and rejects unsafe URLs or partial configuration", () => {
    vi.stubEnv("CHAT_WAKE_URL", ""); vi.stubEnv("CHAT_WAKE_SECRET", "");
    scheduleChatWake();
    expect(mocks.after).not.toHaveBeenCalled();
    vi.stubEnv("CHAT_WAKE_SECRET", secret);
    for (const url of ["", "http://remote.example/internal/chat/wake", "https://user:pass@wake.example/internal/chat/wake", config.url + "?token=private-canary", "https://wake.example/other"]) {
      vi.stubEnv("CHAT_WAKE_URL", url);
      scheduleChatWake();
    }
    expect(mocks.after).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("canary");
  });

  it("does not fail an accepted submission if background scheduling is unavailable", () => {
    vi.stubEnv("CHAT_WAKE_URL", config.url); vi.stubEnv("CHAT_WAKE_SECRET", secret);
    mocks.after.mockImplementationOnce(() => { throw new Error("private-canary"); });
    expect(() => scheduleChatWake()).not.toThrow();
    expect(console.warn).toHaveBeenCalledWith('{"event":"chat_wake_failed","code":"scheduling_failed"}');
  });
});
