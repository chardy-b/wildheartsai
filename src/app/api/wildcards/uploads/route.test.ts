import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), begin: vi.fn(), part: vi.fn(), complete: vi.fn(), configured: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSession: mocks.session }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/records-keys", () => ({ recordsKey: () => Buffer.alloc(32) }));
vi.mock("@/lib/wildcards-r2", () => ({ fileObjects: () => "test-objects", r2Configured: mocks.configured }));
vi.mock("@/lib/wildcards-store", async (original) => ({ ...await original<typeof import("@/lib/wildcards-store")>(), cleanupExpiredUploads: vi.fn(), beginUpload: mocks.begin, uploadPart: mocks.part, completeUpload: mocks.complete }));
import { POST as begin } from "./route";
import { PUT as part } from "./[id]/[part]/route";
import { POST as complete } from "./[id]/complete/route";
import { FileInputError } from "@/lib/wildcards-store";
import { UPLOAD_CHUNK_BYTES } from "@/lib/wildcards";

const origin = "https://app.example";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const context = { params: Promise.resolve({ id, part: "0" }) };
function request(method = "POST", body?: string | Uint8Array<ArrayBuffer>, contentType = "application/json", source = origin) {
  return new Request(`${origin}/api/wildcards/uploads`, { method, headers: { origin: source, "Content-Type": contentType }, body });
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.session.mockResolvedValue({ user: { id: "owner" } }); mocks.configured.mockReturnValue(true);
  mocks.begin.mockResolvedValue({ id, chunkBytes: UPLOAD_CHUNK_BYTES }); mocks.part.mockResolvedValue(undefined); mocks.complete.mockResolvedValue(undefined);
});
describe("bounded document upload endpoints", () => {
  it("authenticates and checks origin on every step", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await begin(request())).status).toBe(401);
    expect((await part(request("PUT"), context)).status).toBe(401);
    expect((await complete(request(), context)).status).toBe(401);
    mocks.session.mockResolvedValue({ user: { id: "owner" } });
    expect((await begin(request("POST", undefined, "application/json", "https://other.example"))).status).toBe(403);
    expect((await part(request("PUT", undefined, "application/octet-stream", "https://other.example"), context)).status).toBe(403);
    expect((await complete(request("POST", undefined, "application/json", "https://other.example"), context)).status).toBe(403);
    expect(mocks.begin).not.toHaveBeenCalled(); expect(mocks.part).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("uses the session owner and sends private responses", async () => {
    const response = await begin(request("POST", JSON.stringify({ name: "photo.jpg", size: 10_000_000, userId: "other" })));
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.begin).toHaveBeenCalledWith({}, expect.any(Buffer), "owner", "photo.jpg", 10_000_000, undefined);
    expect((await part(request("PUT", "hello", "application/octet-stream"), context)).status).toBe(204);
    expect(mocks.part).toHaveBeenCalledWith({}, expect.any(Buffer), "owner", id, 0, Buffer.from("hello"), "test-objects");
    expect((await complete(request(), context)).status).toBe(200);
    expect(mocks.complete).toHaveBeenCalledWith({}, expect.any(Buffer), "owner", id, "test-objects");
  });
  it("rejects malformed metadata and oversized transfers", async () => {
    expect((await begin(request("POST", "bad json"))).status).toBe(400);
    expect((await begin(request("POST", JSON.stringify({ name: 5, size: "25 MB" })))).status).toBe(400);
    expect((await part(request("PUT", new Uint8Array(UPLOAD_CHUNK_BYTES + 1), "application/octet-stream"), context)).status).toBe(400);
    expect((await part(request("PUT", "hello", "application/octet-stream"), { params: Promise.resolve({ id, part: "-1" }) })).status).toBe(404);
    expect(mocks.part).not.toHaveBeenCalled();
  });
  it("passes relative paths with the authenticated owner and rejects non-string paths", async () => {
    const response = await begin(request("POST", JSON.stringify({ name: "note.txt", size: 5, relativePath: "Records/Visits/note.txt", userId: "other" })));
    expect(response.status).toBe(201);
    expect(mocks.begin).toHaveBeenCalledWith({}, expect.any(Buffer), "owner", "note.txt", 5, "Records/Visits/note.txt");
    mocks.begin.mockClear();
    for (const relativePath of [null, 1, [], {}]) {
      expect((await begin(request("POST", JSON.stringify({ name: "note.txt", size: 5, relativePath })))).status).toBe(400);
    }
    expect(mocks.begin).not.toHaveBeenCalled();
  });
  it("passes a valid digest with the authenticated account and rejects malformed digests", async () => {
    const sha256 = "a".repeat(64);
    mocks.begin.mockResolvedValue({ id, status: "ready", skipped: true });
    const response = await begin(request("POST", JSON.stringify({ id, name: "note.txt", size: 5, sha256 })));
    expect(await response.json()).toMatchObject({ skipped: true });
    expect(mocks.begin).toHaveBeenCalledWith({}, expect.any(Buffer), "owner", "note.txt", 5, undefined, id, sha256, "test-objects");
    mocks.begin.mockClear();
    for (const sha256 of [null, 1, "short", "g".repeat(64), "A".repeat(64)]) {
      expect((await begin(request("POST", JSON.stringify({ name: "note.txt", size: 5, sha256 })))).status).toBe(400);
    }
    expect(mocks.begin).not.toHaveBeenCalled();
  });
  it("preserves useful size and quota errors while hiding internal errors", async () => {
    mocks.begin.mockRejectedValue(new FileInputError("This file is 2.1 GB; the limit is 2.0 GB per file.", 413));
    const size = await begin(request("POST", JSON.stringify({ name: "photo.jpg", size: 30_000_000 })));
    expect(size.status).toBe(413); expect(await size.text()).toContain("2.1 GB");
    mocks.complete.mockRejectedValue(new Error("sensitive internal detail"));
    const response = await complete(request(), context);
    expect(response.status).toBe(500); expect(await response.text()).not.toContain("sensitive");
  });
});
