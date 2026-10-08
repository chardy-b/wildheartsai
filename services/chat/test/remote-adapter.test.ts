import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createPrivateToolGateway } from "../src/private-gateway.js";
import { ChatWebApi } from "../src/web-api.js";
import { CHAT_MAX_TOOL_OUTPUT_BYTES } from "../src/protocol.js";

const executionGrant = `whchat1.execution.${"e".repeat(43)}`;
const controlGrant = `whchat1.control.${"c".repeat(43)}`;

async function startGateway(remoteFetch: typeof fetch, modelFetch: typeof fetch = vi.fn(async () => Response.json({ choices: [] }))) {
  const api = new ChatWebApi({ baseUrl: new URL("http://127.0.0.1:8765/api/chat/worker/v1"), fetcher: remoteFetch, maxAttempts: 1 });
  const gateway = createPrivateToolGateway({ api, inferenceUrl: new URL("http://model.internal/v1"), modelId: "configured-model", maxTokens: 16, fetcher: modelFetch });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const port = (gateway.address() as AddressInfo).port;
  return { gateway, url: `http://127.0.0.1:${port}`, close: async () => { gateway.close(); await once(gateway, "close"); } };
}

function headers(grant = executionGrant): Record<string, string> { return { authorization: `Bearer ${grant}`, "content-type": "application/json" }; }

describe("remote worker relay", () => {
  it("rejects unknown routes, wrong credential kind, and scope-bearing request bodies", async () => {
    const remoteFetch = vi.fn(async () => Response.json({ status: "accepted" }));
    const fixture = await startGateway(remoteFetch);
    try {
      expect((await fetch(`${fixture.url}/not-a-worker-route`, { headers: headers() })).status).toBe(404);
      expect((await fetch(`${fixture.url}/v1/worker/context`, { headers: headers(controlGrant) })).status).toBe(401);
      const extraScope = await fetch(`${fixture.url}/v1/tools`, { method: "POST", headers: headers(), body: JSON.stringify({ toolCallId: "call_1", tool: "get_data_coverage", input: {}, userId: "person-a" }) });
      expect(extraScope.status).toBe(400);
      const malformedEvent = await fetch(`${fixture.url}/v1/worker/events`, { method: "POST", headers: headers(), body: JSON.stringify({ eventId: "20000000-0000-4000-8000-000000000001", sequence: 1, type: "answer.delta", data: { text: "", userId: "person-a" } }) });
      expect(malformedEvent.status).toBe(400);
      expect(remoteFetch).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it("forwards execution-only tools and batches worker events through the web API", async () => {
    const requests: Array<{ url: string; authorization: string; body?: unknown }> = [];
    const remoteFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") ?? "", body });
      if (url.endsWith("/execution/tools")) return Response.json({ status: "completed", output: { coverage: "synthetic" } });
      if (url.endsWith("/execution/events")) return Response.json({ status: "accepted" });
      return Response.json({ cancelled: false });
    };
    const fixture = await startGateway(remoteFetch);
    try {
      const tool = await fetch(`${fixture.url}/v1/tools`, { method: "POST", headers: headers(), body: JSON.stringify({ toolCallId: "call_llama_17", tool: "get_data_coverage", input: {} }) });
      expect(tool.status).toBe(200);
      expect(await tool.json()).toEqual({ status: "completed", output: { coverage: "synthetic" } });
      const event = { eventId: "20000000-0000-4000-8000-000000000002", sequence: 1, type: "lifecycle", data: { status: "started" } };
      const emitted = await fetch(`${fixture.url}/v1/worker/events`, { method: "POST", headers: headers(), body: JSON.stringify(event) });
      expect(emitted.status).toBe(202);
      expect(requests.map((request) => request.url)).toEqual([
        "http://127.0.0.1:8765/api/chat/worker/v1/execution/tools",
        "http://127.0.0.1:8765/api/chat/worker/v1/execution/events",
      ]);
      expect(requests.every((request) => request.authorization === `Bearer ${executionGrant}`)).toBe(true);
      expect(requests[0]?.body).toEqual({ toolCallId: "call_llama_17", tool: "get_data_coverage", input: {} });
      expect(requests[1]?.body).toEqual({ events: [event] });
    } finally { await fixture.close(); }
  });

  it("checks web cancellation before forwarding inference and overrides caller model settings", async () => {
    let cancelled = true;
    const remotePaths: string[] = [];
    const remoteFetch: typeof fetch = async (input) => {
      remotePaths.push(String(input));
      return Response.json({ cancelled });
    };
    const modelFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }));
    const fixture = await startGateway(remoteFetch, modelFetch);
    try {
      const inferenceUrl = `${fixture.url}/v1/inference/chat/completions`;
      const requestBody = { model: "caller-model", messages: [{ role: "user", content: "synthetic" }], max_tokens: 999_999, stream: true };
      const revoked = await fetch(inferenceUrl, { method: "POST", headers: headers(), body: JSON.stringify(requestBody) });
      expect(revoked.status).toBe(409);
      expect(modelFetch).not.toHaveBeenCalled();
      cancelled = false;
      const allowed = await fetch(inferenceUrl, { method: "POST", headers: headers(), body: JSON.stringify(requestBody) });
      expect(allowed.status).toBe(200);
      const [modelUrl, init] = modelFetch.mock.calls[0]!;
      expect(String(modelUrl)).toBe("http://model.internal/v1/chat/completions");
      expect(init?.redirect).toBe("error");
      const forwarded = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(forwarded.model).toBe("configured-model");
      expect(forwarded.max_tokens).toBe(16);
      expect(remotePaths.every((url) => url.endsWith("/execution/cancellation"))).toBe(true);
    } finally { await fixture.close(); }
  });

  it("rejects inference redirects instead of forwarding the worker grant or request body", async () => {
    const remoteFetch: typeof fetch = async () => Response.json({ cancelled: false });
    const modelFetch: typeof fetch = vi.fn(async (_input, init) => {
      expect(init?.redirect).toBe("error");
      return new Response(null, { status: 307, headers: { location: "https://attacker.example/collect" } });
    });
    const fixture = await startGateway(remoteFetch, modelFetch);
    try {
      const response = await fetch(`${fixture.url}/v1/inference/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ messages: [{ role: "user", content: "Synthetic prompt" }], stream: true }),
      });
      expect(response.status).toBe(502);
      expect(modelFetch).toHaveBeenCalledTimes(1);
    } finally { await fixture.close(); }
  });

  it("accepts a tool output at the limit with its bounded transport envelope", async () => {
    const output = { data: "x".repeat(CHAT_MAX_TOOL_OUTPUT_BYTES - Buffer.byteLength('{"data":""}')) };
    expect(Buffer.byteLength(JSON.stringify(output))).toBe(CHAT_MAX_TOOL_OUTPUT_BYTES);
    const remoteFetch: typeof fetch = async () => Response.json({ status: "completed", output });
    const fixture = await startGateway(remoteFetch);
    try {
      const response = await fetch(`${fixture.url}/v1/tools`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ toolCallId: "call_large_1", tool: "get_data_coverage", input: {} }),
      });
      expect(response.status).toBe(200);
      const reply = await response.json() as { output: { data: string } };
      expect(reply.output.data).toHaveLength(output.data.length);
    } finally { await fixture.close(); }
  });
});
