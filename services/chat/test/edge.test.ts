import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createEdgeService, type EdgeOptions } from "../src/edge.js";
import { ResearchCorpusError } from "../src/research-corpus.js";

// The edge service chat on Cloudflare uses: inference and research behind one token. Synthetic data.
const token = "t".repeat(43);
const snapshotId = "a".repeat(64), sourceId = "b".repeat(64);
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});

async function start(overrides: Partial<EdgeOptions> = {}) {
  const server = createEdgeService({ tokenHash: createHash("sha256").update(token).digest("hex"), inferenceUrl: new URL("http://inference.invalid/v1/"), modelIds: ["primary-model", "fallback-model"], maxTokens: 512, ...overrides });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no_address");
  return (path: string, body: unknown, auth = `Bearer ${token}`) => fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });
}

const passage = { sourceId, title: "Heart evidence", path: "studies/heart.md", startLine: 1, endLine: 1, excerpt: "heart", offset: 0, nextOffset: null, totalChars: 5, truncated: false };
const corpus = {
  captureSnapshot: async () => ({ snapshotId }),
  search: (id: unknown, input: unknown) => { expect(input).toEqual({ query: "heart", limit: 3 }); return { snapshotId: id, hits: [passage], truncated: false }; },
  read: (id: unknown, input: { sourceId: string }) => { if (input.sourceId !== sourceId) throw new ResearchCorpusError("not_found"); return { ...passage, snapshotId: id }; },
};

describe("edge service", () => {
  it("refuses anyone without the token", async () => {
    const post = await start();
    expect((await post("/v1/research/search", { query: "heart" }, "Bearer " + "x".repeat(43))).status).toBe(401);
    expect((await post("/v1/research/search", { query: "heart" }, "")).status).toBe(401);
  });

  it("relays inference to the configured model with capped tokens, falling back before any output", async () => {
    const seen: { model: string; max_tokens: number }[] = [];
    const fetcher = (async (_url: URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string; max_tokens: number };
      seen.push(body);
      if (body.model === "primary-model") return new Response("busy", { status: 503 });
      return new Response("data: {\"choices\":[]}\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const post = await start({ fetcher });
    const response = await post("/v1/inference/chat/completions", { model: "something-else", messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 9999 });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("[DONE]");
    expect(seen.map((s) => [s.model, s.max_tokens])).toEqual([["primary-model", 512], ["fallback-model", 512]]);
    expect((await post("/v1/inference/chat/completions", { messages: [] })).status).toBe(400);
  });

  it("searches and reads the research corpus, and says when it's missing", async () => {
    const post = await start({ researchCorpus: corpus as never });
    expect(await (await post("/v1/research/search", { query: "heart", limit: 3 })).json()).toEqual({ snapshotId, hits: [passage], truncated: false });
    expect(await (await post("/v1/research/read", { snapshotId, sourceId })).json()).toMatchObject({ snapshotId, sourceId });
    expect((await post("/v1/research/read", { snapshotId, sourceId: "c".repeat(64) })).status).toBe(404);
    expect((await post("/v1/research/search", { query: "heart", userId: "someone" })).status).toBe(400);
    const without = await start();
    expect((await without("/v1/research/search", { query: "heart" })).status).toBe(503);
  });
});

describe("edge runtime", () => {
  it("needs only the token hash and the model, not the old web API settings", async () => {
    const { createEdgeRuntime } = await import("../src/runtime.js");
    const runtime = createEdgeRuntime({ CHAT_EDGE_TOKEN_HASH: "a".repeat(64), CHAT_INFERENCE_URL: "http://127.0.0.1:9913/v1/", CHAT_INFERENCE_MODEL: "local-model" });
    expect(runtime).toMatchObject({ tokenHash: "a".repeat(64), modelIds: ["local-model"] });
    expect(() => createEdgeRuntime({ CHAT_EDGE_TOKEN_HASH: "not-a-hash", CHAT_INFERENCE_URL: "http://127.0.0.1:9913/v1/", CHAT_INFERENCE_MODEL: "local-model" })).toThrow("invalid_chat_edge_token_hash");
  });
});
