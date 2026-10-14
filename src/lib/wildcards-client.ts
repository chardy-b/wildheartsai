import { fileSizeError } from "./wildcards";

class UploadError extends Error { constructor(message: string, public readonly status = 0) { super(message); } }

async function request(url: string, options: RequestInit, retry = false): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      const data = await response.json().catch(() => null);
      throw new UploadError(response.status === 401 ? "Your session has expired. Sign in again, then upload your file." :
        data?.error ?? (response.status === 413 ? "The transfer was too large. Refresh Documents and upload again." : "Document storage could not complete the upload. Please try again."), response.status);
    } catch (error) {
      const canRetry = !(error instanceof UploadError) || error.status >= 500;
      if (retry && canRetry && attempt < 2) continue;
      if (error instanceof UploadError) throw error;
      throw new UploadError("The connection was lost before the upload was confirmed. Check your connection and your file list, then try again.");
    }
  }
}

export async function uploadDocument(file: File, progress: (message: string) => void): Promise<void> {
  const sizeError = fileSizeError(file.size);
  if (sizeError) throw new UploadError(sizeError);
  if (!/\.(pdf|txt|png|jpe?g|gif|webp)$/i.test(file.name)) throw new UploadError("This file type is not supported. Choose a PDF, .txt, PNG, JPEG, GIF, or WebP file.");
  let id: string | undefined;
  try {
    const started = await request("/api/wildcards/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, size: file.size }) });
    const upload = await started.json() as { id: string; chunkBytes: number };
    id = upload.id;
    if (!Number.isSafeInteger(upload.chunkBytes) || upload.chunkBytes <= 0) throw new UploadError("The upload could not start. Refresh Documents and try again.");
    for (let offset = 0, part = 0; offset < file.size; offset += upload.chunkBytes, part++) {
      await request(`/api/wildcards/uploads/${id}/${part}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(offset, offset + upload.chunkBytes) }, true);
      progress(`Uploading… ${Math.round(Math.min(offset + upload.chunkBytes, file.size) / file.size * 100)}%`);
    }
    progress("Checking and saving your file…");
    await request(`/api/wildcards/uploads/${id}/complete`, { method: "POST" }, true);
  } catch (error) {
    if (id) { try { await fetch(`/api/wildcards/${id}`, { method: "DELETE" }); } catch { /* Incomplete uploads remain visible for cleanup. */ } }
    throw error;
  }
}
