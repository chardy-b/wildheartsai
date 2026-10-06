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
