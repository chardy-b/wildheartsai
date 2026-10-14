// Large files use bounded upload pieces and streaming downloads on Vercel.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024;
export const MAX_STORAGE_BYTES = 50 * 1024 * 1024 * 1024;
export const MAX_FILES = 50_000;
export const FILE_ACCEPT = ".pdf,.txt,.png,.jpg,.jpeg,.gif,.webp";

export type WildcardFile = {
  id: string;
  name: string;
  // Includes the selected root folder. Older and standalone uploads omit it.
  relativePath?: string;
  type: string;
  sizeBytes: number;
  uploadedAt: string;
  status: "pending" | "finalizing" | "ready" | "deleting";
};

export function fileSize(bytes: number): string {
  return bytes >= 1024 * 1024 * 1024 ? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileSizeError(bytes: number): string | null {
  if (bytes === 0) return "This file is empty (0 bytes). Choose a file that contains text, an image, or a PDF.";
  if (bytes > MAX_FILE_BYTES) return `This file is ${fileSize(bytes)}; the limit is ${fileSize(MAX_FILE_BYTES)} per file. Choose a smaller file or reduce its size.`;
  return null;
}
