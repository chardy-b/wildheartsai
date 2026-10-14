import { fileSizeError } from "./wildcards";

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
export async function uploadDocument(file: File, progress: (message: string) => void, options: { id?: string; signal?: AbortSignal } = {}): Promise<void> {
  const sizeError = fileSizeError(file.size);
  if (sizeError) throw new UploadError(sizeError, 400);
  if (!/\.(pdf|txt|png|jpe?g|gif|webp)$/i.test(file.name)) throw new UploadError("This file type is not supported. Choose a PDF, .txt, PNG, JPEG, GIF, or WebP file.", 415);
  const id = options.id ?? crypto.randomUUID();
  const { signal } = options;
  const started = await request("/api/wildcards/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, name: file.name, size: file.size }) }, signal);
  const upload = await started.json() as { id: string; chunkBytes: number; status?: string; parts?: string[] };
  if (upload.status === "ready") return;
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
    if (response.status !== 202) return;
    await waitForRetry(2000, signal);
  } while (Date.now() < until);
  throw new UploadError("Your file is still being saved. Pause, then resume to check its status.");
}
