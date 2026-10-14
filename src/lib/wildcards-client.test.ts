import { afterEach, describe, expect, it, vi } from "vitest";
import { fileSizeError, MAX_FILE_BYTES, UPLOAD_CHUNK_BYTES } from "./wildcards";
import { uploadDocument } from "./wildcards-client";

afterEach(() => vi.unstubAllGlobals());
describe("document upload feedback", () => {
  it("distinguishes empty files and reports the actual size and limit", () => {
    expect(fileSizeError(0)).toContain("empty (0 bytes)");
    expect(fileSizeError(28.4 * 1024 * 1024)).toContain("28.4 MB; the limit is 25.0 MB");
    expect(fileSizeError(MAX_FILE_BYTES)).toBeNull();
  });
  it("uploads a large file as bounded pieces and reports progress", async () => {
    const calls: { url: string; body?: BodyInit | null }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body });
      return url.endsWith("/uploads") ? Response.json({ id: "test", chunkBytes: UPLOAD_CHUNK_BYTES }) : new Response(null, { status: 204 });
    }));
    const file = new File([new Uint8Array(UPLOAD_CHUNK_BYTES + 10)], "photo.jpg");
    const progress: string[] = [];
    await uploadDocument(file, (message) => progress.push(message));
    expect(calls.map((call) => call.url)).toEqual(["/api/wildcards/uploads", "/api/wildcards/uploads/test/0", "/api/wildcards/uploads/test/1", "/api/wildcards/uploads/test/complete"]);
    expect((calls[1].body as Blob).size).toBe(UPLOAD_CHUNK_BYTES);
    expect((calls[2].body as Blob).size).toBe(10);
    expect(progress).toContain("Uploading… 100%");
  });
  it("shows a specific sign-in message and preserves server quota errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "generic" }, { status: 401 })));
    await expect(uploadDocument(new File(["hello"], "a.txt"), () => {})).rejects.toThrow("session has expired");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Documents has 99 MB used. Delete files to free space." }, { status: 409 })));
    await expect(uploadDocument(new File(["hello"], "a.txt"), () => {})).rejects.toThrow("Delete files to free space");
  });
  it("retries a failed piece without starting another upload", async () => {
    let starts = 0, parts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/uploads")) { starts++; return Response.json({ id: "test", chunkBytes: UPLOAD_CHUNK_BYTES }); }
      if (url.endsWith("/0") && parts++ === 0) throw new TypeError("offline");
      return new Response(null, { status: 204 });
    }));
    await uploadDocument(new File(["hello"], "a.txt"), () => {});
    expect(starts).toBe(1); expect(parts).toBe(2);
  });
  it("attempts cleanup and explains connection loss when retries fail", async () => {
    const remove = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/uploads")) return Response.json({ id: "test", chunkBytes: UPLOAD_CHUNK_BYTES });
      if (init.method === "DELETE") { remove(); return new Response(null, { status: 204 }); }
      throw new TypeError("offline");
    }));
    await expect(uploadDocument(new File(["hello"], "a.txt"), () => {})).rejects.toThrow("connection was lost");
    expect(remove).toHaveBeenCalledOnce();
  });
});
