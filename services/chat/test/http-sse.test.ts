import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createChatHttpServer } from "../src/http.js";
import type { CapabilityVerifier, ChatRepository } from "../src/contracts.js";

describe("SSE replay", () => {
  it("does not treat a completed GET request as a stream disconnect", async () => {
    const repository = {
      findRunForUser: async () => ({ id: "run-a", conversationId: "conversation-a", status: "running" }),
      getRun: async () => ({ id: "run-a", status: "running" }),
      listEvents: async () => [{ sequence: 1, kind: "answer.delta", payload: { text: "synthetic" }, createdAt: new Date(0) }],
    } as unknown as ChatRepository;
    const verifier: CapabilityVerifier = { verify: async () => ({ userId: "person-a", sessionId: "session-a", credentialId: "ticket-a", expiresAt: new Date(Date.now() + 60_000), audience: "wildhearts-chat" }) };
    const server = createChatHttpServer({ repository, verifier, webOrigin: "https://www.wildheartsai.com", streamPollMs: 100 });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/runs/run-a/events`, { headers: { authorization: "Bearer test" }, signal: controller.signal });
      expect(response.status).toBe(200);
      const first = await response.body?.getReader().read();
      expect(new TextDecoder().decode(first?.value)).toContain('"text":"synthetic"');
    } finally {
      controller.abort();
      server.close();
      await once(server, "close");
    }
  });
});
