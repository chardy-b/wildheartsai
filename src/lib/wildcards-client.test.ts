import { afterEach, describe, expect, it, vi } from "vitest";
import { fileSizeError, MAX_FILE_BYTES, UPLOAD_CHUNK_BYTES } from "./wildcards";
import { uploadDocument } from "./wildcards-client";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("document upload feedback", () => {
  it("retries a lost start response with the same idempotency ID", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/uploads")) {
        bodies.push(init.body as string);
        if (bodies.length === 1) throw new TypeError("lost response");
        return Response.json({ id: "test", chunkBytes: UPLOAD_CHUNK_BYTES });
      }
      return new Response(null, { status: 204 });
    }));
    await uploadDocument(new File(["hello"], "a.txt"), () => {});
    expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]);
  });
  it("polls an in-progress save after a lost completion response without deleting it", async () => {
    const methods: string[] = [];
    let completes = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      methods.push(init.method!);
      if (url.endsWith("/uploads")) return Response.json({ id: "test", chunkBytes: UPLOAD_CHUNK_BYTES });
      if (url.endsWith("/complete")) {
        completes++;
        if (completes === 1) throw new TypeError("lost response");
        if (completes === 2) return Response.json({ error: "Saving" }, { status: 202 });
      }
      return new Response(null, { status: 204 });
    }));
    await uploadDocument(new File(["hello"], "a.txt"), () => {});
    expect(completes).toBe(3); expect(methods).not.toContain("DELETE");
  });
  it("bounds a hung request and lets the user abort without deleting data", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      expect(init.signal).toBeDefined();
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    }));
    vi.stubGlobal("fetch", fetcher);
    const pending = uploadDocument(new File(["hello"], "a.txt"), () => {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
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
  it("preserves the upload and explains connection loss when retries fail", async () => {
    const remove = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/uploads")) return Response.json({ id: "test", chunkBytes: UPLOAD_CHUNK_BYTES });
      if (init.method === "DELETE") { remove(); return new Response(null, { status: 204 }); }
      throw new TypeError("offline");
    }));
    await expect(uploadDocument(new File(["hello"], "a.txt"), () => {})).rejects.toThrow("connection was lost");
    expect(remove).not.toHaveBeenCalled();
  });
});
