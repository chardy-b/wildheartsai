import { fileSizeError } from "./wildcards";
import { MAX_PATH_DEPTH, relativePathError } from "./wildcards-paths";

export class UploadError extends Error {
  constructor(message: string, public readonly status = 0) { super(message); }
  get pausesQueue() { return this.status >= 500 || [0, 401, 403, 409, 429].includes(this.status); }
}

export function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function request(url: string, options: RequestInit, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    let retryAfter = 0;
    try {
      const deadline = AbortSignal.timeout(30_000);
      const response = await fetch(url, { ...options, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      if (response.ok) return response;
      retryAfter = Math.min(30_000, Math.max(0, Number(response.headers.get("retry-after")) * 1000 || 0));
      const data = await response.json().catch(() => null);
      throw new UploadError(response.status === 401 ? "Your session has expired. Sign in again, then resume your queue." :
        data?.error ?? "Document storage could not complete the upload. Please try again.", response.status);
    } catch (error) {
      signal?.throwIfAborted();
      const canRetry = !(error instanceof UploadError) || error.status >= 500 || error.status === 429;
      if (canRetry && attempt < 2) { await waitForRetry(Math.max(retryAfter, 500 * 2 ** attempt), signal); continue; }
      if (error instanceof UploadError) throw error;
      throw new UploadError("The connection was lost or timed out before the upload was confirmed. Resume to safely retry this file.");
    }
  }
}

// Keep this ID with the queued File so retries reconcile with the existing
// reservation and received pieces. Never delete on an uncertain response.
export async function uploadDocument(file: File, progress: (message: string) => void, options: { id?: string; signal?: AbortSignal; relativePath?: string; sha256?: string } | string = {}): Promise<{ skipped: boolean }> {
  const relativePath = typeof options === "string" ? options : options.relativePath ?? (file.webkitRelativePath || undefined);
  const pathError = relativePathError(file.name, relativePath);
  if (pathError) throw new UploadError(pathError, 400);
  const settings = typeof options === "string" ? {} : options;
  const sizeError = fileSizeError(file.size);
  if (sizeError) throw new UploadError(sizeError, 400);
  if (!/\.(pdf|txt|png|jpe?g|gif|webp)$/i.test(file.name)) throw new UploadError("This file type is not supported. Choose a PDF, .txt, PNG, JPEG, GIF, or WebP file.", 415);
  const id = settings.id ?? crypto.randomUUID();
  const { signal } = settings;
  signal?.throwIfAborted();
  const sha256 = settings.sha256 ?? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const startOptions = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, name: file.name, size: file.size, relativePath, sha256 }) };
  const checkingUntil = Date.now() + 150_000;
  let started: Response;
  for (;;) {
    started = await request("/api/wildcards/uploads", startOptions, signal);
    if (started.status !== 202) break;
    progress("Checking existing documents for duplicates…");
    if (Date.now() >= checkingUntil) throw new UploadError("Existing documents are still being checked. Resume to continue the duplicate check.");
    await waitForRetry(2000, signal);
  }
  const upload = await started.json() as { id: string; chunkBytes: number; status?: string; parts?: string[] };
  if (upload.status === "ready") return { skipped: true };
  if (!Number.isSafeInteger(upload.chunkBytes) || upload.chunkBytes <= 0) throw new UploadError("The upload could not start. Refresh Documents and try again.");
  if (upload.status !== "finalizing") {
    for (let offset = 0, part = 0; offset < file.size; offset += upload.chunkBytes, part++) {
      if (!upload.parts?.includes(String(part))) await request(`/api/wildcards/uploads/${upload.id}/${part}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(offset, offset + upload.chunkBytes) }, signal);
      progress(`Uploading… ${Math.round(Math.min(offset + upload.chunkBytes, file.size) / file.size * 100)}%`);
    }
  }
  progress("Checking and saving your file…");
  const until = Date.now() + 150_000;
  do {
    const response = await request(`/api/wildcards/uploads/${upload.id}/complete`, { method: "POST" }, signal);
    if (response.status !== 202) { const result = await response.json().catch(() => null); return { skipped: result?.skipped === true }; }
    await waitForRetry(2000, signal);
  } while (Date.now() < until);
  throw new UploadError("Your file is still being saved. Pause, then resume to check its status.");
}

export type SelectedFile = { file: File; relativePath?: string };

export function selectedFiles(files: FileList | File[]): SelectedFile[] {
  return Array.from(files).map((file) => ({ file, relativePath: file.webkitRelativePath || undefined }));
}

export async function filesFromDrop(transfer: DataTransfer): Promise<SelectedFile[]> {
  // Capture entries synchronously: browsers clear the drag data after the event.
  const items = Array.from(transfer.items ?? []).filter((item) => item.kind === "file");
  const entries = items.map((item) => item.webkitGetAsEntry?.() ?? null);
  const fallback = selectedFiles(transfer.files);
  if (!entries.some(Boolean)) return fallback;
  if (entries.some((entry) => !entry)) throw new Error("This browser could not read the dropped folder. Use Choose folder instead.");
  const files: SelectedFile[] = [];
  async function visit(entry: FileSystemEntry, parent = "", depth = 1): Promise<void> {
    if (depth > MAX_PATH_DEPTH) throw new Error("This folder is more than 32 levels deep. Choose a folder closer to the files.");
    const path = parent ? `${parent}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      files.push({ file, relativePath: parent ? path : undefined });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // Chromium returns directory entries in batches, not all at once.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await visit(child, path, depth + 1);
      }
    }
  }
  for (const entry of entries) await visit(entry!);
  return files;
}
