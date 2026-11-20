import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), store: vi.fn(), read: vi.fn(), remove: vi.fn(), configured: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSession: mocks.session }));
vi.mock("@/lib/wildcards-r2", () => ({ fileObjects: () => "test-objects", r2Configured: mocks.configured }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/records-keys", () => ({ recordsKey: () => Buffer.alloc(32) }));
vi.mock("@/lib/wildcards-store", async (original) => ({ ...await original<typeof import("@/lib/wildcards-store")>(),
  storeFile: mocks.store, streamFile: mocks.read, deleteFile: mocks.remove }));
import { POST } from "./route";
import { GET, DELETE } from "./[id]/route";
import { UPLOAD_CHUNK_BYTES } from "@/lib/wildcards";
import { FileInputError } from "@/lib/wildcards-store";
import { readUpload } from "@/lib/wildcards-http";

const url = "https://app.example/api/wildcards";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const context = { params: Promise.resolve({ id }) };
function upload(origin = "https://app.example", name = "my file.txt", body = "hello") {
  return new Request(url, { method: "POST", headers: { origin, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) }, body });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.configured.mockReturnValue(true);
  mocks.session.mockResolvedValue({ user: { id: "owner" } });
  mocks.store.mockResolvedValue(undefined);
  mocks.read.mockImplementation(async () => ({ name: "Résumé.pdf", type: "application/pdf", stream: new Response("%PDF-1.7").body }));
  mocks.remove.mockResolvedValue(true);
});

describe("private file endpoints", () => {
  it("disables uploads when R2 is not configured", async () => {
    mocks.configured.mockReturnValue(false);
    expect((await POST(upload())).status).toBe(503);
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it("requires a session for upload, view, download, and delete", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await POST(upload())).status).toBe(401);
    expect((await GET(new Request(`${url}/${id}`), context)).status).toBe(401);
    expect((await GET(new Request(`${url}/${id}?download=1`), context)).status).toBe(401);
    expect((await DELETE(new Request(`${url}/${id}`, { method: "DELETE", headers: { origin: "https://app.example" } }), context)).status).toBe(401);
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("rejects cross-origin and missing-origin mutations", async () => {
    expect((await POST(upload("https://other.example"))).status).toBe(403);
    expect((await POST(new Request(url, { method: "POST" }))).status).toBe(403);
    expect((await DELETE(new Request(`${url}/${id}`, { method: "DELETE", headers: { origin: "https://other.example" } }), context)).status).toBe(403);
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("derives ownership from the session and preserves filename and bytes", async () => {
    const response = await POST(upload());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.store).toHaveBeenCalledWith({}, expect.any(Buffer), "owner", "my file.txt", Buffer.from("hello"), "test-objects");
  });
  it("serves inert private responses and encodes the original download filename", async () => {
    for (const download of [false, true]) {
      const response = await GET(new Request(`${url}/${id}${download ? "?download=1" : ""}`), context);
      expect(response.headers.get("content-disposition")).toBe(`${download ? "attachment" : "inline"}; filename="download"; filename*=UTF-8''R%C3%A9sum%C3%A9.pdf`);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("content-security-policy")).toContain("sandbox");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text()).toBe("%PDF-1.7");
    }
    expect(mocks.read).toHaveBeenCalledWith({}, expect.any(Buffer), "owner", id, "test-objects");
  });
  it("returns indistinguishable 404s for missing files and another user's files", async () => {
    mocks.read.mockResolvedValue(null);
    mocks.remove.mockResolvedValue(false);
    expect((await GET(new Request(`${url}/${id}`), context)).status).toBe(404);
    expect((await GET(new Request(url), { params: Promise.resolve({ id: "invalid" }) })).status).toBe(404);
    expect((await DELETE(new Request(`${url}/${id}`, { method: "DELETE", headers: { origin: "https://app.example" } }), context)).status).toBe(404);
  });
  it("streams downloads larger than the buffered hosting limit", async () => {
    const bytes = Buffer.alloc(6 * 1024 * 1024, 0x61);
    mocks.read.mockResolvedValue({ name: "large.txt", type: "text/plain; charset=utf-8", stream: new Response(bytes).body });
    const response = await GET(new Request(`${url}/${id}?download=1`), context);
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.body).toBeInstanceOf(ReadableStream);
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
  });
  it("returns a retryable failure rather than success while historical duplicate checks are incomplete", async () => {
    mocks.store.mockRejectedValue(new FileInputError("Checking existing documents for duplicates. Please retry this upload.", 503));
    const response = await POST(upload());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ error: "Checking existing documents for duplicates. Please retry this upload." });
  });
  it("never exposes internal storage errors", async () => {
    mocks.store.mockRejectedValue(new Error("sensitive database detail"));
    const response = await POST(upload());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("sensitive");
  });
  it("bounds uploads without trusting content-length", async () => {
    const request = new Request(url, { method: "POST", body: new Uint8Array(UPLOAD_CHUNK_BYTES + 1) });
    await expect(readUpload(request)).rejects.toThrow("transfer limit");
  });
});
