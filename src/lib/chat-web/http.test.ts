import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ runtime: vi.fn(), claim: vi.fn(), context: vi.fn(), tool: vi.fn(), heartbeat: vi.fn(), events: vi.fn(), finalize: vi.fn(), researchBegin: vi.fn(), researchResult: vi.fn(), getSession: vi.fn() }));
vi.mock("./runtime", () => ({ webChatRuntime: mocks.runtime, ChatUnavailableError: class extends Error {} }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@/lib/env", () => ({ appUrl: () => "https://wildhearts.example" }));
import { workerRequest } from "./worker-http";
import { browserRequest } from "./browser-http";
import { body, guarded, json } from "./http";
import { ChatAuthorityError, RESEARCH_GATEWAY_HEADER, researchBeginInputSchema } from "./protocol";
const token = `whchat1.execution.${"a".repeat(43)}`;
function request(method: string, value?: unknown, authorization = `Bearer ${token}`) {
  return new Request("https://wildhearts.example/api/chat/worker/v1/execution/tools", { method, headers: { authorization, "content-type": "application/json" }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
}
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });
describe("web chat transport boundary", () => {
  it("correlates a sanitized failure with a fresh server-generated request ID", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.runtime.mockRejectedValueOnce(Object.assign(new Error("private-record-token-canary"), { code: "ECONNRESET" }));
    const req = request("GET");
    req.headers.set("X-Chat-Request-Id", "caller-private-canary");
    const response = await workerRequest(req, ["execution", "context"]);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "chat_unavailable" });
    const requestId = response.headers.get("X-Chat-Request-Id");
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.parse(spy.mock.calls[0][0])).toMatchObject({ requestId, operation: "execution/context", code: "ECONNRESET" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("canary");
    const success = await guarded(async () => json({ ok: true }));
    expect(success.headers.get("X-Chat-Request-Id")).not.toBe(requestId);
  });
  it("logs accepted terminal failures once and keeps duplicate retries quiet", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.runtime.mockResolvedValue({ authority: { events: mocks.events, finalize: mocks.finalize } });
    mocks.events.mockResolvedValueOnce({ status: "accepted" }).mockResolvedValueOnce({ status: "duplicate" });
    const input = { events: [{ eventId: "5d83b16b-75dd-4b78-978e-fb0a57d508d1", sequence: 1, type: "error", data: { code: "inference_unavailable" } }] };
    const response = await workerRequest(request("POST", input), ["execution", "events"]);
    await workerRequest(request("POST", input), ["execution", "events"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0][0])).toMatchObject({ event: "chat_run_failed", code: "inference_unavailable", requestId: response.headers.get("X-Chat-Request-Id") });
    mocks.finalize.mockResolvedValueOnce({ status: "accepted" }).mockResolvedValueOnce({ status: "duplicate" });
    const finalization = { requestId: input.events[0].eventId, status: "failed", errorCode: "runner_start_failed" };
    await workerRequest(request("POST", finalization), ["control", "finalize"]);
    await workerRequest(request("POST", finalization), ["control", "finalize"]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(spy.mock.calls[1][0])).toMatchObject({ event: "chat_run_failed", code: "runner_start_failed" });
  });
  it("rejects cookie-only worker requests before runtime access", async () => {
    const response = await workerRequest(new Request("https://wildhearts.example/api/chat/worker/v1/execution/context", { headers: { cookie: "synthetic-session-cookie" } }), ["execution", "context"]);
    expect(response.status).toBe(401);
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it("forwards only a grant and a validated command, rejecting caller-chosen scope", async () => {
    mocks.runtime.mockResolvedValue({ authority: { tool: mocks.tool } });
    mocks.tool.mockResolvedValue({ status: "completed", output: { synthetic: true } });
    const input = { toolCallId: "call_one", tool: "get_data_coverage", input: {} };
    expect((await workerRequest(request("POST", input), ["execution", "tools"])).status).toBe(200);
    expect(mocks.tool).toHaveBeenCalledWith(token, input);
    mocks.tool.mockClear();
    expect((await workerRequest(request("POST", { ...input, userId: "another-person" }), ["execution", "tools"])).status).toBe(400);
    expect(mocks.tool).not.toHaveBeenCalled();
  });
  it("exposes named operations rather than arbitrary repository RPC", async () => {
    expect((await workerRequest(request("POST", { userId: "another-person" }), ["repository", "listMessages"])).status).toBe(404);
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it("enforces byte limits and sanitizes errors", async () => {
    expect((await guarded(async () => json(await body(request("POST", { text: "x".repeat(70_000) }))))).status).toBe(413);
    const protectedFailure = await guarded(async () => { throw new Error("synthetic-private-record-and-password"); });
    expect(await protectedFailure.text()).not.toContain("private-record");
    const revoked = await guarded(async () => { throw new ChatAuthorityError("run_not_active"); });
    expect(await revoked.json()).toEqual({ error: "run_not_active" });
    expect(revoked.headers.get("cache-control")).toContain("no-store");
  });
  it("rejects cross-origin browser writes before identity or data access", async () => {
    expect((await browserRequest(new Request("https://wildhearts.example/api/chat/v1/conversations", { method: "POST", headers: { origin: "https://attacker.example" } }), ["conversations"])).status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it("rejects unverified browser identity before opening restricted pools", async () => {
    mocks.getSession.mockResolvedValue({ user: { id: "synthetic-user", emailVerified: false }, session: { id: "synthetic-session" } });
    expect((await browserRequest(new Request("https://wildhearts.example/api/chat/v1/conversations"), ["conversations"])).status).toBe(401);
    expect(mocks.runtime).not.toHaveBeenCalled();
  });  it("exposes research only through the two named POST commands and passes the separate gateway credential", async () => {
    mocks.runtime.mockResolvedValue({ authority: { researchBegin: mocks.researchBegin, researchResult: mocks.researchResult } });
    mocks.researchBegin.mockResolvedValue({ status: "execute", operationId: "synthetic-operation", snapshotId: "a".repeat(64) });
    mocks.researchResult.mockResolvedValue({ status: "accepted" });
    const command = researchBeginInputSchema.parse({ toolCallId: "research_one", tool: "search_research", input: { query: "Synthetic" }, proposedSnapshotId: "a".repeat(64) });
    const req = request("POST", command); req.headers.set(RESEARCH_GATEWAY_HEADER, "gateway-credential");
    expect((await workerRequest(req, ["execution", "research", "begin"])).status).toBe(200);
    expect(mocks.researchBegin).toHaveBeenCalledWith(token, "gateway-credential", command);
    const result = { operationId: "5d83b16b-75dd-4b78-978e-fb0a57d508d1", status: "failed", errorCode: "snapshot_unavailable" };
    const res = request("POST", result); res.headers.set(RESEARCH_GATEWAY_HEADER, "gateway-credential");
    expect((await workerRequest(res, ["execution", "research", "result"])).status).toBe(202);
    expect(mocks.researchResult).toHaveBeenCalledWith(token, "gateway-credential", result);
    mocks.researchBegin.mockClear();
    expect((await workerRequest(request("POST", { ...command, input: { ...command.input, path: "/etc/passwd" } }), ["execution", "research", "begin"])).status).toBe(400);
    expect(mocks.researchBegin).not.toHaveBeenCalled();
    expect((await workerRequest(request("GET"), ["execution", "research", "begin"])).status).toBe(404);
  });

});
