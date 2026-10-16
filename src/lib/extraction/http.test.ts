import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/records-keys", () => ({ recordsKey: () => Buffer.alloc(32) }));
vi.mock("./store", () => ({
  configured: vi.fn(() => true), enabledMethods: () => ["native", "tesseract"], hash: () => "b".repeat(64),
  listRuns: vi.fn(async () => []), references: vi.fn(async () => []), enqueue: vi.fn(async () => ["run"]), backfill: vi.fn(async () => ({ enrolled: 674, batchSize: 20 })),
  processingProgress: vi.fn(async () => ({ documents: 708, counts: { not_started: 699, completed: 9 }, files: [] })),
  extractionAudit: vi.fn(async () => ({ rows: [], groups: [] })), rerun: vi.fn(async () => ["child"]),
  authorized: vi.fn(async () => { throw new Error("private provider error"); }), cancel: vi.fn(), claim: vi.fn(), fail: vi.fn(), finish: vi.fn(), saveReference: vi.fn(), workerConfig: vi.fn(),
}));
import { getSession } from "@/lib/session";
import { backfill, claim, configured, enqueue, extractionAudit, fail, listRuns, processingProgress, rerun } from "./store";
import { browserRequest, workerRequest } from "./http";

beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(configured).mockReturnValue(true);
  vi.mocked(getSession).mockResolvedValue({ user: { id: "owner" }, session: { id: "session" } } as Awaited<ReturnType<typeof getSession>>);
});
describe("extraction HTTP boundary", () => {
  it("enrolls backfill only through the authenticated owner and rejects caller-supplied worker configuration", async () => {
    const send = (body: unknown) => browserRequest(new Request("https://app.test/api/extraction", { method: "POST", headers: { origin: "https://app.test" }, body: JSON.stringify(body) }));
    expect(await (await send({ backfill: true })).json()).toEqual({ enrolled: 674, batchSize: 20 });
    expect(backfill).toHaveBeenCalledWith({}, expect.any(Buffer), "owner", "session");
    vi.mocked(backfill).mockClear();
    expect((await send({ backfill: true, userId: "other", pipeline: "vision" })).status).toBe(400);
    expect(backfill).not.toHaveBeenCalled();
  });
  it("accepts finite failure codes and legacy workers but rejects arbitrary diagnostic content", async () => {
    const send = (body: unknown) => workerRequest(new Request("https://app.test/api/extraction/worker/v1/fail", {
      method: "POST", headers: { authorization: "Bearer whdoc1.synthetic" }, body: JSON.stringify(body),
    }), ["fail"]);
    expect((await send({ retryable: false, code: "pdf_page_limit" })).status).toBe(200);
    expect(fail).toHaveBeenLastCalledWith({}, "whdoc1.synthetic", false, "pdf_page_limit");
    expect((await send({ retryable: true })).status).toBe(200);
    expect(fail).toHaveBeenLastCalledWith({}, "whdoc1.synthetic", true, undefined);
    vi.mocked(fail).mockClear();
    for (const payload of [{ code: "synthetic private text" }, { code: "parse_failed", message: "private" }, { code: "parse_failed", stage: "private" }]) {
      const denied = await send(payload);
      expect(denied.status).toBe(403); expect(await denied.text()).not.toContain("private");
    }
    expect(fail).not.toHaveBeenCalled();
  });
  it("scopes private benchmark and reruns to the authenticated owner", async () => {
    const audit = await browserRequest(new Request("https://app.test/api/extraction?benchmark=1"));
    expect(audit.headers.get("cache-control")).toBe("private, no-store");
    expect(extractionAudit).toHaveBeenCalledWith({}, expect.any(Buffer), "owner");
    const id = "11111111-1111-4111-8111-111111111111";
    const response = await browserRequest(new Request("https://app.test/api/extraction", {method:"POST",headers:{origin:"https://app.test"},body:JSON.stringify({rerunOf:id})}));
    expect(await response.json()).toEqual({ids:["child"]});
    expect(rerun).toHaveBeenCalledWith({},expect.any(Buffer),"owner","session",id);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("returns owner-scoped overview metadata without loading results or record keys", async () => {
    const response = await browserRequest(new Request("https://app.test/api/extraction?overview=1"));
    expect(await response.json()).toMatchObject({ documents: 708, counts: { not_started: 699 } });
    expect(processingProgress).toHaveBeenCalledWith({}, "owner"); expect(listRuns).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("denies anonymous reads and cross-origin writes before loading documents", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    expect((await browserRequest(new Request("https://app.test/api/extraction"))).status).toBe(401);
    expect(listRuns).not.toHaveBeenCalled();
    expect((await browserRequest(new Request("https://app.test/api/extraction", { method: "POST", headers: { origin: "https://other.test" }, body: "{}" }))).status).toBe(403);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("keeps queue creation disabled while allowing owner inspection", async () => {
    vi.mocked(configured).mockReturnValue(false);
    const response = await browserRequest(new Request("https://app.test/api/extraction"));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.json()).available).toBe(false);
    const write = await browserRequest(new Request("https://app.test/api/extraction", { method: "POST", headers: { origin: "https://app.test" }, body: "{}" }));
    expect(write.status).toBe(503); expect(enqueue).not.toHaveBeenCalled();
  });
  it("rejects malformed ids without querying and rejects unbounded bodies", async () => {
    expect((await browserRequest(new Request("https://app.test/api/extraction?fileId=wrong"))).status).toBe(404);
    expect(listRuns).not.toHaveBeenCalled();
    const response = await browserRequest(new Request("https://app.test/api/extraction", { method: "POST", headers: { origin: "https://app.test", "content-length": "999999999" }, body: "{}" }));
    expect(response.status).toBe(400); expect(enqueue).not.toHaveBeenCalled();
  });
  it("does not let an execution grant claim jobs or return raw backend errors", async () => {
    process.env.EXTRACTION_COORDINATOR_TOKEN_HASH = "a".repeat(64);
    const request = new Request("https://app.test/api/extraction/worker/v1/claim", { method: "POST", headers: { authorization: "Bearer whdoc1.synthetic" }, body: "{}" });
    expect((await workerRequest(request, ["claim"])).status).toBe(401); expect(claim).not.toHaveBeenCalled();
    const denied = await workerRequest(new Request("https://app.test/api/extraction/worker/v1/source", { headers: { authorization: "Bearer whdoc1.synthetic" } }), ["source"]);
    expect(denied.status).toBe(403); expect(await denied.text()).not.toContain("private provider");
    delete process.env.EXTRACTION_COORDINATOR_TOKEN_HASH;
  });
});
