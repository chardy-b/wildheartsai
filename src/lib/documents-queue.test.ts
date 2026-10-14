import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentQueue } from "./documents-queue";
import { UploadError } from "./wildcards-client";

const file = (name: string) => new File([name], `${name}.txt`, { lastModified: 1 });
afterEach(() => vi.unstubAllGlobals());
describe("bulk document queue", () => {
  it("stops a thousand-file batch on quota errors and retries only failures", async () => {
    const transfer = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new UploadError("Full", 409)).mockResolvedValue(undefined);
    const queue = new DocumentQueue(vi.fn(), "owner", transfer);
    queue.add(Array.from({ length: 1000 }, (_, i) => file(String(i))));
    await vi.waitFor(() => expect(queue.running).toBe(false));
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(queue.done).toBe(1); expect(queue.failed).toBe(1); expect(queue.paused).toBe(true);
    queue.retry();
    await vi.waitFor(() => expect(queue.running).toBe(false), { timeout: 10_000 });
    expect(queue.done).toBe(1000); expect(transfer).toHaveBeenCalledTimes(1001);
    expect(transfer.mock.calls[1][2].id).toBe(transfer.mock.calls[2][2].id);
  });
  it("accepts additional drops during a transfer and skips duplicate selections", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const transfer = vi.fn().mockImplementationOnce(() => gate).mockResolvedValue(undefined);
    const queue = new DocumentQueue(vi.fn(), "owner", transfer);
    const first = file("first"); queue.add([first]);
    await vi.waitFor(() => expect(transfer).toHaveBeenCalledOnce());
    queue.add([first, file("second")]); expect(queue.items).toHaveLength(2); expect(queue.notice).toContain("skipped");
    release(); await vi.waitFor(() => expect(queue.done).toBe(2));
  });
  it("keeps different files with identical metadata and the same file in different folders", async () => {
    const transfer = vi.fn().mockResolvedValue(undefined);
    const queue = new DocumentQueue(vi.fn(), "owner", transfer);
    const first = new File(["one"], "note.txt", { lastModified: 1 });
    const second = new File(["two"], "note.txt", { lastModified: 1 });
    queue.add([{ file: first, relativePath: "A/note.txt" }, { file: first, relativePath: "B/note.txt" }, { file: second, relativePath: "A/note.txt" }]);
    await vi.waitFor(() => expect(queue.done).toBe(3));
    expect(transfer.mock.calls.map((call) => call[2].relativePath)).toEqual(["A/note.txt", "B/note.txt", "A/note.txt"]);
    expect(new Set(transfer.mock.calls.map((call) => call[2].id)).size).toBe(3);
  });
  it("pauses an active request without losing its ID and resumes it", async () => {
    const transfer = vi.fn().mockImplementationOnce((_file, _progress, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason)))).mockResolvedValue(undefined);
    const queue = new DocumentQueue(vi.fn(), "owner", transfer); queue.add([file("first"), file("second")]);
    await vi.waitFor(() => expect(transfer).toHaveBeenCalledOnce()); queue.pause();
    await vi.waitFor(() => expect(queue.running).toBe(false)); expect(queue.failed).toBe(0);
    queue.resume(); await vi.waitFor(() => expect(queue.done).toBe(2));
    expect(transfer.mock.calls[0][2].id).toBe(transfer.mock.calls[1][2].id);
  });
  it("reconciles completed and interrupted files after a reload without storing names", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) });
    const transfer = vi.fn().mockResolvedValue(undefined);
    const first = new DocumentQueue(vi.fn(), "owner", transfer); first.add([file("private-health-note")]);
    await vi.waitFor(() => expect(first.done).toBe(1));
    const next = new DocumentQueue(vi.fn(), "owner", transfer); next.add([file("private-health-note")]);
    await vi.waitFor(() => expect(next.done).toBe(1));
    expect(transfer.mock.calls[0][2].id).toBe(transfer.mock.calls[1][2].id);
    expect([...storage.keys()].join()).not.toContain("private-health-note");
  });
});
