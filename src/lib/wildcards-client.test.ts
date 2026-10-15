import { afterEach, describe, expect, it, vi } from "vitest";
import { fileSizeError, MAX_FILE_BYTES, UPLOAD_CHUNK_BYTES } from "./wildcards";
import { filesFromDrop, selectedFiles, uploadDocument } from "./wildcards-client";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("document upload feedback", () => {
  it("skips a server-confirmed duplicate without sending any file chunks", async () => {
    const fetcher = vi.fn<(url: string, options: RequestInit) => Promise<Response>>().mockResolvedValue(Response.json({ id: "existing", status: "ready", skipped: true }));
    vi.stubGlobal("fetch", fetcher);
    expect(await uploadDocument(new File(["hello"], "renamed.txt"), () => {})).toEqual({ skipped: true });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string).sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("continues a bounded older-document check before sending file chunks", async () => {
    let starts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/uploads")) {
        starts++;
        return starts === 1 ? Response.json({ error: "Checking" }, { status: 202 }) : Response.json({ status: "ready", id: "existing" });
      }
      throw new Error("File contents must not be sent");
    }));
    const progress: string[] = [];
    expect(await uploadDocument(new File(["hello"], "note.txt"), (message) => progress.push(message))).toEqual({ skipped: true });
    expect(starts).toBe(2); expect(progress).toContain("Checking existing documents for duplicates…");
  });
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
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("distinguishes empty files and reports the actual size and limit", () => {
    expect(fileSizeError(0)).toContain("empty (0 bytes)");
    expect(fileSizeError(28.4 * 1024 * 1024)).toBeNull();
    expect(fileSizeError(2.1 * 1024 * 1024 * 1024)).toContain("2.1 GB; the limit is 2.0 GB");
    expect(fileSizeError(MAX_FILE_BYTES)).toBeNull();
    expect(fileSizeError(MAX_FILE_BYTES + 1)).toContain("the limit is 2.0 GB");
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
  it("sends folder-picker relative paths and explicit drop paths without changing the filename", async () => {
    const starts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/uploads")) { starts.push(JSON.parse(init.body as string)); return Response.json({ id: "test", chunkBytes: UPLOAD_CHUNK_BYTES }); }
      return new Response(null, { status: 204 });
    }));
    const file = new File(["hello"], "note.txt");
    Object.defineProperty(file, "webkitRelativePath", { value: "Records/Visits/note.txt" });
    expect(selectedFiles([file])).toEqual([{ file, relativePath: "Records/Visits/note.txt" }]);
    await uploadDocument(file, () => {});
    await uploadDocument(new File(["hello"], "note.txt"), () => {}, "Records/Labs/note.txt");
    await uploadDocument(new File(["hello"], "note.txt"), () => {});
    expect(starts).toEqual([
      { sha256: expect.any(String), id: expect.any(String), name: "note.txt", size: 5, relativePath: "Records/Visits/note.txt" },
      { sha256: expect.any(String), id: expect.any(String), name: "note.txt", size: 5, relativePath: "Records/Labs/note.txt" },
      { sha256: expect.any(String), id: expect.any(String), name: "note.txt", size: 5 },
    ]);
  });
  it("rejects unsafe paths before making upload requests", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(uploadDocument(new File(["hello"], "note.txt"), () => {}, "../note.txt")).rejects.toThrow("relative file path");
    expect(fetch).not.toHaveBeenCalled();
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

function entryFile(name: string): FileSystemEntry {
  return { name, isFile: true, isDirectory: false, file: (resolve: (file: File) => void) => resolve(new File(["hello"], name)) } as unknown as FileSystemEntry;
}
function directory(name: string, batches: FileSystemEntry[][]): FileSystemEntry {
  return { name, isFile: false, isDirectory: true, createReader: () => {
    let index = 0;
    return { readEntries: (resolve: (entries: FileSystemEntry[]) => void) => resolve(batches[index++] ?? []) };
  } } as unknown as FileSystemEntry;
}
function transfer(entries: FileSystemEntry[]): DataTransfer {
  return { items: entries.map((entry) => ({ kind: "file", webkitGetAsEntry: () => entry })), files: [] } as unknown as DataTransfer;
}
describe("folder drag and drop", () => {
  it("reads every batch, nested folders, and mixed standalone files", async () => {
    const folder = directory("Records", [[entryFile("summary.txt")], [directory("Visits", [[entryFile("note.txt")]])]]);
    const files = await filesFromDrop(transfer([folder, entryFile("loose.txt")]));
    expect(files.map(({ file, relativePath }) => [file.name, relativePath])).toEqual([
      ["summary.txt", "Records/summary.txt"], ["note.txt", "Records/Visits/note.txt"], ["loose.txt", undefined],
    ]);
  });
  it("falls back to ordinary files without the entry API and ignores non-file items", async () => {
    const file = new File(["hello"], "note.txt");
    const data = { items: [{ kind: "string" }, { kind: "file" }], files: [file] } as unknown as DataTransfer;
    expect(await filesFromDrop(data)).toEqual([{ file, relativePath: undefined }]);
  });
  it("handles empty folders and rejects unreadable or overly deep folders", async () => {
    expect(await filesFromDrop(transfer([directory("Empty", [])]))).toEqual([]);
    const unreadable = { name: "Records", isDirectory: true, createReader: () => ({ readEntries: (_resolve: unknown, reject: (error: Error) => void) => reject(new Error("Cannot read folder")) }) } as unknown as FileSystemEntry;
    await expect(filesFromDrop(transfer([unreadable]))).rejects.toThrow("Cannot read folder");
    let deep = entryFile("note.txt");
    for (let i = 0; i < 32; i++) deep = directory(`Folder${i}`, [[deep]]);
    await expect(filesFromDrop(transfer([deep]))).rejects.toThrow("32 levels deep");
  });
});
