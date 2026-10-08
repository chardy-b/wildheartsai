import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { mintRunnerCapability } from "../src/capabilities.js";
import type { ChatRepository, ChatScope } from "../src/contracts.js";
import { PiHealthRunner } from "../src/pi-runner.js";
import { createPrivateToolGateway } from "../src/private-gateway.js";

const key = new TextEncoder().encode("a test key that is long enough for HS256 signing");
const scope: ChatScope = { userId: "person-a", conversationId: "conversation-a", runId: "run-a", credentialId: "ticket-a", expiresAt: new Date(Date.now() + 60_000), runAttempt: 1, workerId: "worker-a" };

describe("Pi health runner", () => {
  it("streams a synthetic OpenAI-compatible answer through the private data gateway", async () => {
    const repository = {
      isWorkerLeaseCurrent: async () => true,
      isCancellationRequested: async () => false,
      loadRunContext: async () => [{ role: "user" as const, content: "What synthetic result is available?" }],
    } as unknown as ChatRepository;
    const sse = [
      'data: {"id":"synthetic","object":"chat.completion.chunk","created":1,"model":"synthetic-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Synthetic result [evidence-1]"},"finish_reason":null}]}\n\n',
      'data: {"id":"synthetic","object":"chat.completion.chunk","created":1,"model":"synthetic-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const server = createPrivateToolGateway({
      repository,
      runnerKey: key,
      issuer: "chat-service",
      modelProxy: async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const capability = await mintRunnerCapability(scope, key, "chat-service", 1, "worker-a");
    const events: string[] = [];
    const runner = new PiHealthRunner({ gatewayUrl: new URL(`http://127.0.0.1:${port}`), capability, modelId: "synthetic-model" }, async (event) => { events.push(event.type); });
    try {
      await expect(runner.run(new AbortController().signal)).resolves.toBe("Synthetic result [evidence-1]");
      expect(events).toContain("answer.delta");
      expect(events.at(-1)).toBe("completed");
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("batches many provider deltas within the byte cap and flushes before completion", async () => {
    const repository = {
      isWorkerLeaseCurrent: async () => true,
      isCancellationRequested: async () => false,
      loadRunContext: async () => [{ role: "user" as const, content: "Repeat the synthetic result." }],
    } as unknown as ChatRepository;
    const sse = [
      ...Array.from({ length: 80 }, () => 'data: {"id":"synthetic","object":"chat.completion.chunk","created":1,"model":"synthetic-model","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}\n\n'),
      'data: {"id":"synthetic","object":"chat.completion.chunk","created":1,"model":"synthetic-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const server = createPrivateToolGateway({
      repository,
      runnerKey: key,
      issuer: "chat-service",
      modelProxy: async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const capability = await mintRunnerCapability(scope, key, "chat-service", 1, "worker-a");
    const events: Array<{ type: string; data: Record<string, unknown>; sequence: number }> = [];
    const runner = new PiHealthRunner({ gatewayUrl: new URL(`http://127.0.0.1:${port}`), capability, modelId: "synthetic-model", deltaFlushMs: 1_000, maxDeltaBytes: 17 }, async (event) => { events.push(event); });
    try {
      await expect(runner.run(new AbortController().signal)).resolves.toBe("x".repeat(80));
      const deltas = events.filter((event) => event.type === "answer.delta");
      expect(deltas.length).toBeLessThan(80);
      expect(deltas.every((event) => Buffer.byteLength(String(event.data.text), "utf8") <= 17)).toBe(true);
      expect(deltas.map((event) => event.data.text).join("")).toBe("x".repeat(80));
      const finalDelta = events.reduce((last, event, index) => event.type === "answer.delta" ? index : last, -1);
      const completedMessage = events.findIndex((event) => event.type === "message.completed");
      const completed = events.findIndex((event) => event.type === "completed");
      expect(finalDelta).toBeLessThan(completedMessage);
      expect(completedMessage).toBeLessThan(completed);
      expect(events[completed]!.data.answer).toBe("x".repeat(80));
      expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("flushes buffered text before starting a tool", async () => {
    const repository = {
      isWorkerLeaseCurrent: async () => true,
      isCancellationRequested: async () => false,
      loadRunContext: async () => [{ role: "user" as const, content: "Check coverage." }],
      invokeTool: async () => ({ status: "completed", output: { available: true } }),
    } as unknown as ChatRepository;
    let requestCount = 0;
    const first = [
      'data: {"id":"synthetic","object":"chat.completion.chunk","created":1,"model":"synthetic-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Before tool "},"finish_reason":null}]}\n\n',
      'data: {"id":"synthetic","object":"chat.completion.chunk","created":1,"model":"synthetic-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_coverage","type":"function","function":{"name":"get_data_coverage","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"synthetic","object":"chat.completion.chunk","created":1,"model":"synthetic-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const second = [
      'data: {"id":"synthetic","object":"chat.completion.chunk","created":1,"model":"synthetic-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Coverage checked [evidence-1]."},"finish_reason":null}]}\n\n',
      'data: {"id":"synthetic","object":"chat.completion.chunk","created":1,"model":"synthetic-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const server = createPrivateToolGateway({
      repository,
      runnerKey: key,
      issuer: "chat-service",
      modelProxy: async () => new Response(++requestCount === 1 ? first : second, { headers: { "content-type": "text/event-stream" } }),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const capability = await mintRunnerCapability(scope, key, "chat-service", 1, "worker-a");
    const events: string[] = [];
    const runner = new PiHealthRunner({ gatewayUrl: new URL(`http://127.0.0.1:${port}`), capability, modelId: "synthetic-model", deltaFlushMs: 1_000 }, async (event) => { events.push(event.type); });
    try {
      await expect(runner.run(new AbortController().signal)).resolves.toBe("Coverage checked [evidence-1].");
      expect(events.indexOf("answer.delta")).toBeLessThan(events.indexOf("tool.started"));
      expect(events.indexOf("tool.started")).toBeLessThan(events.indexOf("tool.completed"));
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("aborts an open provider and propagates a timed event sink failure", async () => {
    const repository = {
      isWorkerLeaseCurrent: async () => true,
      isCancellationRequested: async () => false,
      loadRunContext: async () => [{ role: "user" as const, content: "Start a slow answer." }],
    } as unknown as ChatRepository;
    let proxyStarted!: () => void;
    const started = new Promise<void>((resolve) => { proxyStarted = resolve; });
    let upstreamAborted!: () => void;
    const aborted = new Promise<void>((resolve) => { upstreamAborted = resolve; });
    const server = createPrivateToolGateway({
      repository,
      runnerKey: key,
      issuer: "chat-service",
      modelProxy: async ({ signal }) => {
        proxyStarted();
        signal.addEventListener("abort", upstreamAborted, { once: true });
        const firstDelta = 'data: {"id":"synthetic","object":"chat.completion.chunk","created":1,"model":"synthetic-model","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
        const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(firstDelta)); } });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const capability = await mintRunnerCapability(scope, key, "chat-service", 1, "worker-a");
    const runner = new PiHealthRunner({ gatewayUrl: new URL(`http://127.0.0.1:${port}`), capability, modelId: "synthetic-model", deltaFlushMs: 20 }, async (event) => {
      if (event.type === "answer.delta") throw new Error("synthetic event sink failure");
    });
    try {
      const run = runner.run(new AbortController().signal);
      await started;
      await expect(run).rejects.toThrow("synthetic event sink failure");
      await aborted;
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("drops a buffered delta when the run is cancelled", async () => {
    const repository = {
      isWorkerLeaseCurrent: async () => true,
      isCancellationRequested: async () => false,
      loadRunContext: async () => [{ role: "user" as const, content: "Start a slow answer." }],
    } as unknown as ChatRepository;
    let proxyStarted!: () => void;
    const started = new Promise<void>((resolve) => { proxyStarted = resolve; });
    const server = createPrivateToolGateway({
      repository,
      runnerKey: key,
      issuer: "chat-service",
      modelProxy: async () => {
        proxyStarted();
        const firstDelta = 'data: {"id":"synthetic","object":"chat.completion.chunk","created":1,"model":"synthetic-model","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
        const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(firstDelta)); } });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const capability = await mintRunnerCapability(scope, key, "chat-service", 1, "worker-a");
    const events: string[] = [];
    const controller = new AbortController();
    const runner = new PiHealthRunner({ gatewayUrl: new URL(`http://127.0.0.1:${port}`), capability, modelId: "synthetic-model", deltaFlushMs: 1_000 }, async (event) => { events.push(event.type); });
    try {
      const run = runner.run(controller.signal);
      await started;
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      await expect(run).rejects.toMatchObject({ name: "AbortError" });
      await new Promise((resolve) => setTimeout(resolve, 1_050));
      expect(events).not.toContain("answer.delta");
      expect(events).not.toContain("message.completed");
      expect(events).not.toContain("completed");
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("accepts a provider tool-call identifier without treating it as a database UUID", async () => {
    let seen = "";
    const repository = {
      isWorkerLeaseCurrent: async () => true,
      isCancellationRequested: async () => false,
      invokeTool: async (_scope: unknown, request: { toolCallId: string }) => { seen = request.toolCallId; return { status: "completed", output: {} }; },
    } as unknown as ChatRepository;
    const server = createPrivateToolGateway({ repository, runnerKey: key, issuer: "chat-service" });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const capability = await mintRunnerCapability(scope, key, "chat-service", 1, "worker-a");
    const port = (server.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/tools`, { method: "POST", headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" }, body: JSON.stringify({ toolCallId: "call_llama_17", tool: "get_data_coverage", input: {} }) });
      expect(response.status).toBe(200);
      expect(seen).toBe("call_llama_17");
    } finally { server.close(); await once(server, "close"); }
  });
});
