import { describe, expect, it, vi } from "vitest";
import { ChatWebApi } from "../src/web-api.js";

const executionGrant = `whchat1.execution.${"e".repeat(43)}`;
const controlGrant = `whchat1.control.${"c".repeat(43)}`;
const localBase = new URL("http://127.0.0.1:8765/api/chat/worker/v1");

describe("web authority HTTP adapter", () => {
  it("retries claims with the same request ID and serialized body", async () => {
    const seen: Array<{ url: string; body: string | undefined; authorization: string | undefined }> = [];
    const api = new ChatWebApi({
      baseUrl: localBase,
      coordinatorToken: "synthetic-coordinator-token-with-enough-length",
      maxAttempts: 3,
      random: () => 0.5,
      sleep: async () => undefined,
      fetcher: async (input, init) => {
        seen.push({ url: String(input), body: init?.body as string | undefined, authorization: new Headers(init?.headers).get("authorization") ?? undefined });
        return seen.length === 1 ? Response.json({ error: "temporary" }, { status: 503 }) : Response.json({ run: null });
      },
    });
    const claim = { requestId: "20000000-0000-4000-8000-000000000001", workerId: "worker-test" };
    await expect(api.claim(claim)).resolves.toEqual({ run: null });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]?.url).toBe("http://127.0.0.1:8765/api/chat/worker/v1/claims");
    expect(seen[0]?.authorization).toBe("Bearer synthetic-coordinator-token-with-enough-length");
    expect(JSON.parse(seen[0]!.body!)).toEqual(claim);
  });

  it("honors a bounded Retry-After response before retrying a claim", async () => {
    const delays: number[] = [];
    let requests = 0;
    const api = new ChatWebApi({
      baseUrl: localBase,
      coordinatorToken: "synthetic-coordinator-token-with-enough-length",
      maxAttempts: 2,
      random: () => 0,
      sleep: async (ms) => { delays.push(ms); },
      fetcher: async () => ++requests === 1
        ? new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "retry-after": "2" } })
        : Response.json({ run: null }),
    });
    await expect(api.claim({ requestId: "20000000-0000-4000-8000-000000000001", workerId: "worker-test" })).resolves.toEqual({ run: null });
    expect(requests).toBe(2);
    expect(delays).toEqual([2_000]);
  });

  it("fails closed on an HTTP redirect before any worker credential can be forwarded", async () => {
    const fetcher: typeof fetch = vi.fn(async (_input, init) => {
      expect(init?.redirect).toBe("error");
      return new Response(null, { status: 307, headers: { location: "https://attacker.example/collect" } });
    });
    const api = new ChatWebApi({ baseUrl: localBase, fetcher, maxAttempts: 1 });
    await expect(api.isCancelled(executionGrant)).rejects.toMatchObject({ status: 307 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps execution and control grants operation-bound", async () => {
    const seen: Array<{ url: string; authorization: string; research: string | null }> = [];
    const api = new ChatWebApi({
      baseUrl: localBase,
      fetcher: async (input, init) => {
        const url = String(input);
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        seen.push({ url, authorization, research: new Headers(init?.headers).get("x-chat-research-gateway-token") });
        if (url.endsWith("/execution/context")) return Response.json({ messages: [{ role: "user", content: "Synthetic question" }], modelId: "synthetic-model" });
        if (url.endsWith("/control/heartbeat")) return Response.json({ active: true, cancelled: false, deadlineAt: "2026-10-08T20:00:00.000Z" });
        return Response.json({ status: "accepted" });
      },
    });
    await expect(api.context(executionGrant)).resolves.toMatchObject({ modelId: "synthetic-model" });
    await expect(api.heartbeat(controlGrant)).resolves.toMatchObject({ active: true, cancelled: false });
    expect(seen[0]?.authorization).toBe(`Bearer ${executionGrant}`);
    expect(seen[1]?.authorization).toBe(`Bearer ${controlGrant}`);
    expect(seen.map((item) => item.research)).toEqual([null, null]);
    await expect(api.context(controlGrant)).rejects.toThrow("invalid_execution_grant");
    await expect(api.heartbeat(executionGrant)).rejects.toThrow("invalid_control_grant");
    expect(seen).toHaveLength(2);
  });

  it("retries research begin with identical bytes and sends the raw credential only on research routes", async () => {
    const seen: Array<{ url: string; body: string | undefined; authorization: string | null; research: string | null }> = [];
    const gatewayToken = "r".repeat(43);
    const api = new ChatWebApi({
      baseUrl: localBase,
      maxAttempts: 2,
      random: () => 0,
      sleep: async () => undefined,
      fetcher: async (input, init) => {
        seen.push({ url: String(input), body: init?.body as string | undefined, authorization: new Headers(init?.headers).get("authorization"), research: new Headers(init?.headers).get("x-chat-research-gateway-token") });
        if (seen.length === 1) return new Response("{}", { status: 503 });
        if (String(input).endsWith("/execution/cancellation")) return Response.json({ cancelled: false });
        return Response.json({ status: "execute", operationId: "20000000-0000-4000-8000-000000000099", snapshotId: "a".repeat(64), deadlineAt: "2026-10-08T20:00:00.000Z" });
      },
    });
    const input = { toolCallId: "call_1", tool: "search_research" as const, input: { query: "heart", limit: 5 }, proposedSnapshotId: "a".repeat(64) };
    await expect(api.researchBegin(executionGrant, gatewayToken, input)).resolves.toMatchObject({ status: "execute", snapshotId: "a".repeat(64) });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]?.url).toBe("http://127.0.0.1:8765/api/chat/worker/v1/execution/research/begin");
    expect(seen[0]?.authorization).toBe(`Bearer ${executionGrant}`);
    expect(seen[0]?.research).toBe(gatewayToken);

    await api.isCancelled(executionGrant);
    expect(seen[2]?.research).toBeNull();
  });

  it("validates strict research replies and result bodies before sending", async () => {
    const api = new ChatWebApi({
      baseUrl: localBase,
      maxAttempts: 1,
      fetcher: async () => Response.json({ status: "execute", operationId: "bad", snapshotId: "a".repeat(64), deadlineAt: "later" }),
    });
    await expect(api.researchBegin(executionGrant, "r".repeat(43), {
      toolCallId: "call_1", tool: "search_research", input: { query: "heart", limit: 5 }, proposedSnapshotId: "a".repeat(64),
    })).rejects.toThrow("chat_web_api_invalid_reply");
    await expect(api.researchResult(executionGrant, "r".repeat(43), {
      operationId: "20000000-0000-4000-8000-000000000099", status: "completed", output: { snapshotId: "a".repeat(64), hits: [], truncated: false },
      extra: true,
    } as never)).rejects.toThrow();
  });

  it("rejects unsafe origins and replies containing database scope", async () => {
    expect(() => new ChatWebApi({ baseUrl: new URL("http://example.com/api/chat/worker/v1") })).toThrow("invalid_chat_web_api_url");
    expect(() => new ChatWebApi({ baseUrl: new URL("http://whchat-test-worker-web:8080/api/chat/worker/v1") })).toThrow("invalid_chat_web_api_url");
    expect(() => new ChatWebApi({ baseUrl: new URL("https://www.wildheartsai.com/api/chat/worker/v1?userId=person") })).toThrow("invalid_chat_web_api_url");
    const api = new ChatWebApi({
      baseUrl: localBase,
      coordinatorToken: "synthetic-coordinator-token-with-enough-length",
      maxAttempts: 1,
      fetcher: async () => Response.json({ run: null, userId: "person-a" }),
    });
    await expect(api.claim({ requestId: "20000000-0000-4000-8000-000000000001", workerId: "worker-test" })).rejects.toThrow("chat_web_api_invalid_reply");
  });
});
