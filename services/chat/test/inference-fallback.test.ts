import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createPrivateToolGateway } from "../src/private-gateway.js";
import { ChatWebApi } from "../src/web-api.js";

const executionGrant = `whchat1.execution.${"f".repeat(43)}`;
const primary = "qwen3.8-27b-q6k-112k-mtp-dual-rocm";
const backup = "qwen3.8-27b-gsq9070-112k-mtp-dual-rocm";
const inferenceRequest = {
  model: "caller-selected-model",
  messages: [{ role: "user", content: "Synthetic prompt" }],
  tools: [{ type: "function", function: { name: "synthetic_tool", parameters: { type: "object" } } }],
  max_tokens: 4000,
  stream: true,
};

async function startFixture(modelFetch: typeof fetch, options: { fallbackModelIds?: readonly string[]; attemptTimeoutMs?: number } = {}) {
  const api = new ChatWebApi({
    baseUrl: new URL("http://127.0.0.1:8765/api/chat/worker/v1"),
    maxAttempts: 1,
    fetcher: async () => Response.json({ cancelled: false }),
  });
  const gateway = createPrivateToolGateway({
    api,
    inferenceUrl: new URL("http://model.internal/v1"),
    modelId: primary,
    maxTokens: 2048,
    ...options,
    fetcher: modelFetch,
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const port = (gateway.address() as AddressInfo).port;
  return {
    gateway,
    url: `http://127.0.0.1:${port}/v1/inference/chat/completions`,
    close: async () => { gateway.close(); await once(gateway, "close"); },
  };
}

function headers(): Record<string, string> { return { authorization: `Bearer ${executionGrant}`, "content-type": "application/json" }; }
function stream(text: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

describe("private gateway inference fallback", () => {
  it("uses only the configured primary when it succeeds and preserves the request except model selection", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const modelFetch: typeof fetch = vi.fn(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return stream("primary response");
    });
    const fixture = await startFixture(modelFetch, { fallbackModelIds: [backup] });
    try {
      const response = await fetch(fixture.url, { method: "POST", headers: headers(), body: JSON.stringify(inferenceRequest) });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-wh-chat-model")).toBe(primary);
      expect(await response.text()).toContain("primary response");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toEqual({
        messages: inferenceRequest.messages,
        tools: inferenceRequest.tools,
        stream: true,
        max_tokens: 2048,
        model: primary,
      });
    } finally { await fixture.close(); }
  });

  it.each([404, 408, 429, 500, 502, 503, 504])("retries HTTP %i on the next configured model before sending headers", async (status) => {
    const models: string[] = [];
    const modelFetch: typeof fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      models.push(body.model);
      return models.length === 1 ? new Response("", { status }) : stream("backup response");
    });
    const fixture = await startFixture(modelFetch, { fallbackModelIds: [backup] });
    try {
      const response = await fetch(fixture.url, { method: "POST", headers: headers(), body: JSON.stringify(inferenceRequest) });
      expect(models).toEqual([primary, backup]);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-wh-chat-model")).toBe(backup);
      expect(await response.text()).toContain("backup response");
      expect(models).toEqual([primary, backup]);
    } finally { await fixture.close(); }
  });

  it("retries a connection failure and a first-byte timeout but releases the failed response", async () => {
    const models: string[] = [];
    const modelFetch: typeof fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      models.push(body.model);
      if (models.length === 1) {
        const error = new TypeError("fetch failed", { cause: Object.assign(new Error("synthetic socket reset"), { code: "ECONNRESET" }) });
        throw error;
      }
      return stream("backup after connection failure");
    });
    const fixture = await startFixture(modelFetch, { fallbackModelIds: [backup] });
    try {
      const response = await fetch(fixture.url, { method: "POST", headers: headers(), body: JSON.stringify(inferenceRequest) });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-wh-chat-model")).toBe(backup);
      expect(await response.text()).toContain("backup after connection failure");
      expect(models).toEqual([primary, backup]);
    } finally { await fixture.close(); }

    const timeoutModels: string[] = [];
    const timeoutFetch: typeof fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      timeoutModels.push(body.model);
      if (timeoutModels.length === 1) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const pending = new ReadableStream<Uint8Array>({
          start(controller) {
            timer = setTimeout(() => controller.enqueue(new TextEncoder().encode("late chunk")), 2_000);
            init?.signal?.addEventListener("abort", () => {
              if (timer) clearTimeout(timer);
              controller.error(new DOMException("aborted", "AbortError"));
            }, { once: true });
          },
          cancel() { if (timer) clearTimeout(timer); },
        });
        return new Response(pending, { headers: { "content-type": "text/event-stream" } });
      }
      return stream("backup after timeout");
    });
    const timeoutFixture = await startFixture(timeoutFetch, { fallbackModelIds: [backup], attemptTimeoutMs: 40 });
    try {
      const response = await fetch(timeoutFixture.url, { method: "POST", headers: headers(), body: JSON.stringify(inferenceRequest) });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-wh-chat-model")).toBe(backup);
      expect(await response.text()).toContain("backup after timeout");
      expect(timeoutModels).toEqual([primary, backup]);
    } finally { await timeoutFixture.close(); }

    const headerTimeoutModels: string[] = [];
    const headerTimeoutFetch: typeof fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      headerTimeoutModels.push(body.model);
      if (headerTimeoutModels.length === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      return stream("backup after header timeout");
    });
    const headerTimeoutFixture = await startFixture(headerTimeoutFetch, { fallbackModelIds: [backup], attemptTimeoutMs: 40 });
    try {
      const response = await fetch(headerTimeoutFixture.url, { method: "POST", headers: headers(), body: JSON.stringify(inferenceRequest) });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-wh-chat-model")).toBe(backup);
      expect(await response.text()).toContain("backup after header timeout");
      expect(headerTimeoutModels).toEqual([primary, backup]);
    } finally { await headerTimeoutFixture.close(); }
  });

  it("does not retry when the upstream fails after forwarding the first chunk", async () => {
    const models: string[] = [];
    const modelFetch: typeof fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      models.push(body.model);
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: synthetic-first-chunk\n\n"));
          setTimeout(() => controller.error(new Error("synthetic stream failure")), 20);
        },
      }), { headers: { "content-type": "text/event-stream" } });
    });
    const fixture = await startFixture(modelFetch, { fallbackModelIds: [backup] });
    try {
      const response = await fetch(fixture.url, { method: "POST", headers: headers(), body: JSON.stringify(inferenceRequest) });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-wh-chat-model")).toBe(primary);
      expect(await response.text()).toContain("synthetic-first-chunk");
      expect(models).toEqual([primary]);
    } finally { await fixture.close(); }
  });

  it("does not start a fallback after the client disconnects", async () => {
    let started!: () => void;
    const attemptStarted = new Promise<void>((resolve) => { started = resolve; });
    const modelFetch: typeof fetch = vi.fn(async (_input, init) => {
      started();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    const fixture = await startFixture(modelFetch, { fallbackModelIds: [backup] });
    const abort = new AbortController();
    try {
      const responsePromise = fetch(fixture.url, { method: "POST", headers: headers(), body: JSON.stringify(inferenceRequest), signal: abort.signal });
      await attemptStarted;
      abort.abort();
      await expect(responsePromise).rejects.toMatchObject({ name: "AbortError" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(modelFetch).toHaveBeenCalledTimes(1);
    } finally { abort.abort(); await fixture.close(); }
  });

  it("does not start another attempt after the absolute inference budget expires", async () => {
    let clockOffsetMs = 0;
    const actualNow = Date.now;
    const now = vi.spyOn(Date, "now").mockImplementation(() => actualNow() + clockOffsetMs);
    const modelFetch: typeof fetch = vi.fn(async () => {
      clockOffsetMs = 120_001;
      return new Response("", { status: 503 });
    });
    const fixture = await startFixture(modelFetch, { fallbackModelIds: [backup] });
    try {
      const response = await fetch(fixture.url, { method: "POST", headers: headers(), body: JSON.stringify(inferenceRequest) });
      expect(response.status).toBe(502);
      expect(modelFetch).toHaveBeenCalledTimes(1);
    } finally { now.mockRestore(); await fixture.close(); }
  });

  it.each([400, 401, 403, 302])("does not retry HTTP %i", async (status) => {
    const modelFetch: typeof fetch = vi.fn(async () => new Response("", { status }));
    const fixture = await startFixture(modelFetch, { fallbackModelIds: [backup] });
    try {
      const response = await fetch(fixture.url, { method: "POST", headers: headers(), body: JSON.stringify(inferenceRequest) });
      expect(response.status).toBe(502);
      expect(modelFetch).toHaveBeenCalledTimes(1);
    } finally { await fixture.close(); }
  });

  it("does not retry the fetch error shape used for redirect:error", async () => {
    const redirectError = new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    const modelFetch: typeof fetch = vi.fn(async () => { throw redirectError; });
    const fixture = await startFixture(modelFetch, { fallbackModelIds: [backup] });
    try {
      const response = await fetch(fixture.url, { method: "POST", headers: headers(), body: JSON.stringify(inferenceRequest) });
      expect(response.status).toBe(502);
      expect(modelFetch).toHaveBeenCalledTimes(1);
    } finally { await fixture.close(); }
  });

  it("rechecks web cancellation before a fallback attempt", async () => {
    let cancellationChecks = 0;
    const api = new ChatWebApi({
      baseUrl: new URL("http://127.0.0.1:8765/api/chat/worker/v1"),
      maxAttempts: 1,
      fetcher: async () => Response.json({ cancelled: ++cancellationChecks > 1 }),
    });
    const modelFetch: typeof fetch = vi.fn(async () => new Response("", { status: 503 }));
    const gateway = createPrivateToolGateway({ api, inferenceUrl: new URL("http://model.internal/v1"), modelId: primary, fallbackModelIds: [backup], maxTokens: 2048, fetcher: modelFetch });
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    const port = (gateway.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/inference/chat/completions`, { method: "POST", headers: headers(), body: JSON.stringify(inferenceRequest) });
      expect(response.status).toBe(502);
      expect(cancellationChecks).toBe(2);
      expect(modelFetch).toHaveBeenCalledTimes(1);
    } finally { gateway.close(); await once(gateway, "close"); }
  });

  it("rejects duplicate or unbounded fallback configuration", () => {
    const api = new ChatWebApi({ baseUrl: new URL("http://127.0.0.1:8765/api/chat/worker/v1") });
    const base = { api, inferenceUrl: new URL("http://model.internal/v1"), modelId: primary, maxTokens: 2048 };
    expect(() => createPrivateToolGateway({ ...base, fallbackModelIds: [primary] })).toThrow("invalid_chat_inference_models");
    expect(() => createPrivateToolGateway({ ...base, fallbackModelIds: ["backup1", "backup2", "backup3", "backup4"] })).toThrow("invalid_chat_inference_models");
    expect(() => createPrivateToolGateway({ ...base, attemptTimeoutMs: 120_001 })).toThrow("invalid_chat_inference_attempt_timeout");
  });
});
