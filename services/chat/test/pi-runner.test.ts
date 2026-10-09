import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { PiHealthRunner } from "../src/pi-runner.js";
import { ChatWebApi } from "../src/web-api.js";
import { GatewayToolClient } from "../src/private-gateway.js";
import { createPrivateToolGateway } from "../src/private-gateway.js";

const executionGrant = `whchat1.execution.${"e".repeat(43)}`;
const context = { messages: [{ role: "user", content: "What synthetic result is available?" }], modelId: "synthetic-model" };

async function fixture(inferenceResponses: ReadonlyArray<string>, options: { failAnswerDelta?: boolean; cancelled?: boolean; openInference?: boolean; context?: typeof context } = {}) {
  const eventRows: Array<{ type: string; data: Record<string, unknown>; sequence: number }> = [];
  const toolRequests: Array<Record<string, unknown>> = [];
  let contextRequestCount = 0;
  let inferenceStarted!: () => void;
  let inferenceAborted!: () => void;
  const inferenceStartedPromise = new Promise<void>((resolve) => { inferenceStarted = resolve; });
  const inferenceAbortedPromise = new Promise<void>((resolve) => { inferenceAborted = resolve; });
  const web = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${executionGrant}`) { response.writeHead(401); return response.end("{}"); }
    if (request.url === "/api/chat/worker/v1/execution/context" && request.method === "GET") {
      contextRequestCount += 1;
      return response.end(JSON.stringify(options.context ?? context));
    }
    if (request.url === "/api/chat/worker/v1/execution/cancellation" && request.method === "GET") return response.end(JSON.stringify({ cancelled: options.cancelled ?? false }));
    if (request.url === "/api/chat/worker/v1/execution/events" && request.method === "POST") {
      let text = ""; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text) as { events: Array<{ type: string; data: Record<string, unknown>; sequence: number }> };
      if (options.failAnswerDelta && body.events.some((event) => event.type === "answer.delta")) {
        response.writeHead(503, { "content-type": "application/json" });
        return response.end(JSON.stringify({ error: "synthetic_failure" }));
      }
      eventRows.push(...body.events);
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ status: "accepted" }));
    }
    if (request.url === "/api/chat/worker/v1/execution/tools" && request.method === "POST") {
      let text = ""; for await (const chunk of request) text += chunk;
      toolRequests.push(JSON.parse(text) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ status: "completed", output: { available: true } }));
    }
    response.writeHead(404); response.end("{}");
  });
  web.listen(0, "127.0.0.1"); await once(web, "listening");
  const webPort = (web.address() as AddressInfo).port;
  const api = new ChatWebApi({ baseUrl: new URL(`http://127.0.0.1:${webPort}/api/chat/worker/v1`) });
  let inferenceRequest = 0;
  const gateway = createPrivateToolGateway({
    api,
    inferenceUrl: new URL("http://model.internal/v1"),
    modelId: "synthetic-model",
    maxTokens: 32,
    fetcher: async (_input, init) => {
      inferenceStarted();
      if (options.openInference) {
        init?.signal?.addEventListener("abort", () => inferenceAborted(), { once: true });
        const firstDelta = 'data: {"id":"synthetic","object":"chat.completion.chunk","created":1,"model":"synthetic-model","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
        const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(firstDelta)); } });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(inferenceResponses[inferenceRequest++] ?? "", { headers: { "content-type": "text/event-stream" } });
    },
  });
  gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
  const gatewayPort = (gateway.address() as AddressInfo).port;
  const gatewayUrl = new URL(`http://127.0.0.1:${gatewayPort}`);
  const workerGateway = new GatewayToolClient(gatewayUrl, executionGrant);
  return {
    eventRows,
    toolRequests,
    get contextRequestCount() { return contextRequestCount; },
    inferenceStarted: inferenceStartedPromise,
    inferenceAborted: inferenceAbortedPromise,
    gatewayUrl,
    workerGateway,
    async close() {
      gateway.close(); web.close();
      await Promise.all([once(gateway, "close"), once(web, "close")]);
    },
  };
}

function stream(parts: ReadonlyArray<{ content?: string; tool_calls?: unknown[] }>, finishReason: string): string {
  return [
    ...parts.map((delta) => `data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: "synthetic-model", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`),
    `data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: "synthetic-model", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

describe("Pi health runner", () => {
  it("streams a synthetic OpenAI-compatible answer through the private data gateway", async () => {
    const web = stream([{ content: "Synthetic result [evidence-1]" }], "stop");
    const fixtureValue = await fixture([web]);
    const runner = new PiHealthRunner({ gatewayUrl: fixtureValue.gatewayUrl, capability: executionGrant, modelId: "synthetic-model" }, (event) => fixtureValue.workerGateway.publish(event, new AbortController().signal).then(() => undefined));
    try {
      await expect(runner.run(new AbortController().signal)).resolves.toBe("Synthetic result [evidence-1]");
      expect(fixtureValue.eventRows.map((event) => event.type)).toContain("answer.delta");
      expect(fixtureValue.eventRows.at(-1)?.type).toBe("completed");
    } finally {
      await fixtureValue.close();
    }
  });

  it("relays arbitrary provider call IDs and preserves tool boundary event order", async () => {
    const first = stream([
      { content: "Before tool " },
      { tool_calls: [{ index: 0, id: "call_llama_17", type: "function", function: { name: "get_data_coverage", arguments: "{}" } }] },
    ], "tool_calls");
    const second = stream([{ content: "Coverage checked [evidence-1]." }], "stop");
    const fixtureValue = await fixture([first, second]);
    const runner = new PiHealthRunner({ gatewayUrl: fixtureValue.gatewayUrl, capability: executionGrant, modelId: "synthetic-model" }, (event) => fixtureValue.workerGateway.publish(event, new AbortController().signal).then(() => undefined));
    try {
      await expect(runner.run(new AbortController().signal)).resolves.toBe("Coverage checked [evidence-1].");
      expect(fixtureValue.toolRequests).toEqual([expect.objectContaining({ toolCallId: "call_llama_17", tool: "get_data_coverage", input: {} })]);
      const types = fixtureValue.eventRows.map((event) => event.type);
      expect(types.indexOf("answer.delta")).toBeLessThan(types.indexOf("tool.started"));
      expect(types.indexOf("tool.started")).toBeLessThan(types.indexOf("tool.completed"));
      expect(types.at(-1)).toBe("completed");
    } finally { await fixtureValue.close(); }
  });

  it("reuses one fetched context for worker setup and run with a large valid transcript", async () => {
    const largeContext = {
      messages: [
        { role: "assistant" as const, content: "x".repeat(80_000) },
        { role: "user" as const, content: "Summarize my synthetic context." },
      ],
      modelId: "synthetic-model",
    };
    const fixtureValue = await fixture([stream([{ content: "Synthetic summary." }], "stop")], { context: largeContext });
    const signal = new AbortController().signal;
    const loadedContext = await fixtureValue.workerGateway.loadContext(signal);
    expect(Buffer.byteLength(JSON.stringify(loadedContext.messages), "utf8")).toBeGreaterThan(64 * 1024);
    const runner = new PiHealthRunner({ gatewayUrl: fixtureValue.gatewayUrl, capability: executionGrant, modelId: loadedContext.modelId, gatewayClient: fixtureValue.workerGateway }, (event) => fixtureValue.workerGateway.publish(event, signal).then(() => undefined));
    try {
      await expect(runner.run(signal)).resolves.toBe("Synthetic summary.");
      expect(fixtureValue.contextRequestCount).toBe(1);
    } finally { await fixtureValue.close(); }
  });

  it("batches many provider deltas within the byte cap and flushes before completion", async () => {
    const response = stream(Array.from({ length: 80 }, () => ({ content: "x" })), "stop");
    const fixtureValue = await fixture([response]);
    const runner = new PiHealthRunner({ gatewayUrl: fixtureValue.gatewayUrl, capability: executionGrant, modelId: "synthetic-model", deltaFlushMs: 1_000, maxDeltaBytes: 17 }, (event) => fixtureValue.workerGateway.publish(event, new AbortController().signal).then(() => undefined));
    try {
      await expect(runner.run(new AbortController().signal)).resolves.toBe("x".repeat(80));
      const deltas = fixtureValue.eventRows.filter((event) => event.type === "answer.delta");
      expect(deltas.length).toBeLessThan(80);
      expect(deltas.every((event) => Buffer.byteLength(String(event.data.text), "utf8") <= 17)).toBe(true);
      expect(deltas.map((event) => event.data.text).join("")).toBe("x".repeat(80));
      const finalDelta = fixtureValue.eventRows.reduce((last, event, index) => event.type === "answer.delta" ? index : last, -1);
      const completedMessage = fixtureValue.eventRows.findIndex((event) => event.type === "message.completed");
      const completed = fixtureValue.eventRows.findIndex((event) => event.type === "completed");
      expect(finalDelta).toBeLessThan(completedMessage);
      expect(completedMessage).toBeLessThan(completed);
      expect(fixtureValue.eventRows[completed]?.data.answer).toBe("x".repeat(80));
      expect(fixtureValue.eventRows.map((event) => event.sequence)).toEqual(fixtureValue.eventRows.map((_, index) => index + 1));
    } finally { await fixtureValue.close(); }
  });

  it("aborts an open provider and propagates a timed event publish failure", async () => {
    const fixtureValue = await fixture([], { failAnswerDelta: true, openInference: true });
    const runner = new PiHealthRunner({ gatewayUrl: fixtureValue.gatewayUrl, capability: executionGrant, modelId: "synthetic-model", deltaFlushMs: 20 }, (event) => fixtureValue.workerGateway.publish(event, new AbortController().signal).then(() => undefined));
    try {
      const run = runner.run(new AbortController().signal);
      await fixtureValue.inferenceStarted;
      await expect(run).rejects.toThrow();
      await fixtureValue.inferenceAborted;
      expect(fixtureValue.eventRows.some((event) => event.type === "answer.delta")).toBe(false);
    } finally { await fixtureValue.close(); }
  });

  it("drops buffered text when cancellation happens before the timer flush", async () => {
    const fixtureValue = await fixture([], { openInference: true });
    const controller = new AbortController();
    const runner = new PiHealthRunner({ gatewayUrl: fixtureValue.gatewayUrl, capability: executionGrant, modelId: "synthetic-model", deltaFlushMs: 1_000 }, (event) => fixtureValue.workerGateway.publish(event, controller.signal).then(() => undefined));
    try {
      const run = runner.run(controller.signal);
      await fixtureValue.inferenceStarted;
      await new Promise((resolve) => setTimeout(resolve, 40));
      controller.abort();
      await expect(run).rejects.toMatchObject({ name: "AbortError" });
      await fixtureValue.inferenceAborted;
      await new Promise((resolve) => setTimeout(resolve, 1_050));
      expect(fixtureValue.eventRows.some((event) => event.type === "answer.delta")).toBe(false);
      expect(fixtureValue.eventRows.some((event) => ["message.completed", "completed"].includes(event.type))).toBe(false);
    } finally { await fixtureValue.close(); }
  });
});
