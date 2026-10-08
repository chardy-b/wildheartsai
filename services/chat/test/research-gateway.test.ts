import { type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ResearchCorpusError } from "../src/research-corpus.js";
import { createPrivateToolGateway } from "../src/private-gateway.js";
import type { ChatWebApi } from "../src/web-api.js";

const executionGrant = `whchat1.execution.${"e".repeat(43)}`;
const gatewayToken = "r".repeat(43);
const snapshotId = "a".repeat(64);
const sourceId = "b".repeat(64);
const operationId = "20000000-0000-4000-8000-000000000099";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

function searchOutput(id = snapshotId) {
  return {
    snapshotId: id,
    hits: [{ sourceId, title: "Heart evidence", path: "studies/heart.md", startLine: 1, endLine: 1, excerpt: "heart", offset: 0, nextOffset: null, totalChars: 5, truncated: false }],
    truncated: false,
  };
}

async function startGateway(api: Record<string, unknown>, corpus?: Record<string, unknown>): Promise<{ url: string; close: () => Promise<void> }> {
  const gateway = createPrivateToolGateway({
    api: api as unknown as ChatWebApi,
    inferenceUrl: new URL("http://127.0.0.1:8081/v1"),
    modelId: "synthetic-model",
    maxTokens: 128,
    ...(corpus ? { researchCorpus: corpus as never, researchGatewayToken: gatewayToken } : {}),
  });
  servers.push(gateway);
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  if (!address || typeof address === "string") throw new Error("test_gateway_did_not_bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => gateway.close(() => resolve())),
  };
}

function researchRequest(toolCallId = "research_1") {
  return { toolCallId, tool: "search_research", input: { query: "heart", limit: 5 } };
}

describe("offline research private-gateway dispatch", () => {
  it("begins before query search, persists strict output before replying, and isolates the raw credential", async () => {
    const order: string[] = [];
    let receivedToken = "";
    let receivedGrant = "";
    let beginBody: unknown;
    let patientArguments: unknown[] = [];
    const api = {
      isCancelled: async () => { order.push("active"); return false; },
      researchBegin: async (grant: string, token: string, input: unknown) => {
        order.push("begin"); receivedGrant = grant; receivedToken = token; beginBody = input;
        return { status: "execute", operationId, snapshotId, deadlineAt: "2026-10-08T20:00:00.000Z" };
      },
      researchResult: async (_grant: string, _token: string, input: unknown) => { order.push("result"); expect(input).toMatchObject({ operationId, status: "completed", output: searchOutput() }); return { status: "accepted" }; },
      invokeTool: async (...args: unknown[]) => { order.push("patient-tool"); patientArguments = args; return { status: "completed", output: { ok: true } }; },
    };
    const corpus = {
      captureSnapshot: async () => { order.push("capture"); return { snapshotId }; },
      search: (id: string) => { order.push("search"); expect(id).toBe(snapshotId); return searchOutput(id); },
      read: () => { throw new Error("unexpected_read"); },
    };
    const { url } = await startGateway(api, corpus);
    const response = await fetch(`${url}/v1/tools`, { method: "POST", headers: { authorization: `Bearer ${executionGrant}`, "content-type": "application/json" }, body: JSON.stringify(researchRequest()) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "completed", output: searchOutput() });
    expect(order.indexOf("begin")).toBeLessThan(order.indexOf("search"));
    expect(order.indexOf("search")).toBeLessThan(order.indexOf("result"));
    expect(receivedGrant).toBe(executionGrant);
    expect(receivedToken).toBe(gatewayToken);
    expect(beginBody).toMatchObject({ tool: "search_research", proposedSnapshotId: snapshotId });

    const patient = await fetch(`${url}/v1/tools`, { method: "POST", headers: { authorization: `Bearer ${executionGrant}`, "content-type": "application/json" }, body: JSON.stringify({ toolCallId: "patient_1", tool: "find_records", input: { query: "lab" } }) });
    expect(await patient.json()).toEqual({ status: "completed", output: { ok: true } });
    expect(order).toContain("patient-tool");
    expect(patientArguments).toHaveLength(2);
    expect(JSON.stringify(patientArguments)).not.toContain(gatewayToken);
  });

  it("returns no research output when result persistence fails", async () => {
    const api = {
      isCancelled: async () => false,
      researchBegin: async () => ({ status: "execute", operationId, snapshotId, deadlineAt: "2026-10-08T20:00:00.000Z" }),
      researchResult: async () => { throw new Error("private-persistence-detail"); },
    };
    const corpus = { captureSnapshot: async () => ({ snapshotId }), search: () => searchOutput(), read: () => undefined };
    const { url } = await startGateway(api, corpus);
    const response = await fetch(`${url}/v1/tools`, { method: "POST", headers: { authorization: `Bearer ${executionGrant}`, "content-type": "application/json" }, body: JSON.stringify(researchRequest()) });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "worker_gateway_unavailable" });
  });

  it("persists fixed lookup failures and uses the web-returned pinned snapshot", async () => {
    const order: string[] = [];
    const pinned = "c".repeat(64);
    let persistedCode = "";
    const api = {
      isCancelled: async () => false,
      researchBegin: async () => ({ status: "execute", operationId, snapshotId: pinned, deadlineAt: "2026-10-08T20:00:00.000Z" }),
      researchResult: async (_grant: string, _token: string, input: { errorCode?: string }) => { order.push("persist"); persistedCode = input.errorCode ?? ""; return { status: "accepted" }; },
    };
    const corpus = {
      captureSnapshot: async () => ({ snapshotId }),
      search: (id: string) => { order.push(`search:${id}`); return searchOutput(id); },
      read: () => undefined,
    };
    const { url } = await startGateway(api, corpus);
    const response = await fetch(`${url}/v1/tools`, { method: "POST", headers: { authorization: `Bearer ${executionGrant}`, "content-type": "application/json" }, body: JSON.stringify(researchRequest()) });
    expect(await response.json()).toEqual({ status: "completed", output: searchOutput(pinned) });
    expect(order).toContain(`search:${pinned}`);
    expect(persistedCode).toBe("");
  });

  it("records initial capture failure through the null-snapshot failed-begin path", async () => {
    let begin: unknown;
    let resultCalls = 0;
    const api = {
      isCancelled: async () => false,
      researchBegin: async (_grant: string, _token: string, input: unknown) => {
        begin = input;
        return { status: "failed", operationId, errorCode: "research_unavailable" };
      },
      researchResult: async () => { resultCalls += 1; return { status: "accepted" }; },
    };
    const corpus = { captureSnapshot: async () => { throw new ResearchCorpusError("unavailable"); }, search: () => undefined, read: () => undefined };
    const { url } = await startGateway(api, corpus);
    const response = await fetch(`${url}/v1/tools`, { method: "POST", headers: { authorization: `Bearer ${executionGrant}`, "content-type": "application/json" }, body: JSON.stringify(researchRequest()) });
    expect(await response.json()).toEqual({ status: "failed", errorCode: "research_unavailable" });
    expect(begin).toMatchObject({ proposedSnapshotId: null, failureCode: "research_unavailable" });
    expect(resultCalls).toBe(0);
  });

  it("uses a web-persisted search pin when the corpus is unavailable after restart", async () => {
    const pinnedSnapshot = "c".repeat(64);
    let begin: Record<string, unknown> | undefined;
    let searchedSnapshot = "";
    let resultError = "";
    const api = {
      isCancelled: async () => false,
      researchBegin: async (_grant: string, _token: string, input: Record<string, unknown>) => {
        begin = input;
        return { status: "execute", operationId, snapshotId: pinnedSnapshot, deadlineAt: "2026-10-08T20:00:00.000Z" };
      },
      researchResult: async (_grant: string, _token: string, input: { errorCode?: string }) => { resultError = input.errorCode ?? ""; return { status: "accepted" }; },
    };
    const corpus = {
      captureSnapshot: async () => { throw new ResearchCorpusError("unavailable"); },
      search: (id: string) => { searchedSnapshot = id; throw new ResearchCorpusError("unavailable"); },
      read: () => undefined,
    };
    const { url } = await startGateway(api, corpus);
    const response = await fetch(`${url}/v1/tools`, { method: "POST", headers: { authorization: `Bearer ${executionGrant}`, "content-type": "application/json" }, body: JSON.stringify(researchRequest()) });
    expect(await response.json()).toEqual({ status: "failed", errorCode: "snapshot_unavailable" });
    expect(begin).toMatchObject({ proposedSnapshotId: null, failureCode: "research_unavailable" });
    expect(searchedSnapshot).toBe(pinnedSnapshot);
    expect(resultError).toBe("snapshot_unavailable");
  });

  it("reports a lost pinned snapshot as unavailable after restart, without falling forward", async () => {
    const oldSnapshot = "d".repeat(64);
    let readSnapshot = "";
    let errorCode = "";
    const api = {
      isCancelled: async () => false,
      researchBegin: async () => ({ status: "execute", operationId, snapshotId: oldSnapshot, deadlineAt: "2026-10-08T20:00:00.000Z" }),
      researchResult: async (_grant: string, _token: string, input: { errorCode?: string }) => { errorCode = input.errorCode ?? ""; return { status: "accepted" }; },
    };
    const corpus = {
      captureSnapshot: async () => ({ snapshotId }),
      search: () => undefined,
      read: (id: string) => { readSnapshot = id; throw new ResearchCorpusError("not_found"); },
    };
    const { url } = await startGateway(api, corpus);
    const request = { toolCallId: "read_1", tool: "read_research", input: { snapshotId: oldSnapshot, sourceId, offset: 0, limit: 100 } };
    const response = await fetch(`${url}/v1/tools`, { method: "POST", headers: { authorization: `Bearer ${executionGrant}`, "content-type": "application/json" }, body: JSON.stringify(request) });
    expect(await response.json()).toEqual({ status: "failed", errorCode: "snapshot_unavailable" });
    expect(readSnapshot).toBe(oldSnapshot);
    expect(errorCode).toBe("snapshot_unavailable");
  });

  it("checks run activity before a cached result is returned", async () => {
    let calls = 0;
    const api = {
      isCancelled: async () => { calls += 1; return calls > 1; },
      researchBegin: async () => ({ status: "completed", operationId, output: searchOutput() }),
    };
    const corpus = { captureSnapshot: async () => ({ snapshotId }), search: () => searchOutput(), read: () => undefined };
    const { url } = await startGateway(api, corpus);
    const response = await fetch(`${url}/v1/tools`, { method: "POST", headers: { authorization: `Bearer ${executionGrant}`, "content-type": "application/json" }, body: JSON.stringify(researchRequest()) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "worker_gateway_unavailable" });
    expect(calls).toBe(2);
  });

  it("checks run activity before any corpus capture or search", async () => {
    let corpusReads = 0;
    let begins = 0;
    const api = {
      isCancelled: async () => true,
      researchBegin: async () => { begins += 1; return { status: "failed", operationId, errorCode: "research_unavailable" }; },
    };
    const corpus = { captureSnapshot: async () => { corpusReads += 1; return { snapshotId }; }, search: () => { corpusReads += 1; return searchOutput(); }, read: () => undefined };
    const { url } = await startGateway(api, corpus);
    const response = await fetch(`${url}/v1/tools`, { method: "POST", headers: { authorization: `Bearer ${executionGrant}`, "content-type": "application/json" }, body: JSON.stringify(researchRequest()) });
    expect(response.status).toBe(409);
    expect(corpusReads).toBe(0);
    expect(begins).toBe(0);
  });
});
