import { fileSizeError } from "./wildcards";
import { MAX_PATH_DEPTH, relativePathError } from "./wildcards-paths";

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

export async function uploadDocument(file: File, progress: (message: string) => void, relativePath = file.webkitRelativePath || undefined): Promise<void> {
  const pathError = relativePathError(file.name, relativePath);
  if (pathError) throw new UploadError(pathError);
  const sizeError = fileSizeError(file.size);
  if (sizeError) throw new UploadError(sizeError);
  if (!/\.(pdf|txt|png|jpe?g|gif|webp)$/i.test(file.name)) throw new UploadError("This file type is not supported. Choose a PDF, .txt, PNG, JPEG, GIF, or WebP file.");
  let id: string | undefined;
  try {
    const started = await request("/api/wildcards/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, size: file.size, relativePath }) });
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
