// Shared limits keep each request and binary response below Vercel's payload limit.
export const MAX_FILE_BYTES = 3 * 1024 * 1024;
export const MAX_STORAGE_BYTES = 100 * 1024 * 1024;
export const MAX_FILES = 200;
export const FILE_ACCEPT = ".pdf,.txt,.png,.jpg,.jpeg,.gif,.webp";

export type WildcardFile = {
  id: string;
  name: string;
  type: string;
  sizeBytes: number;
  uploadedAt: string;
  status: "pending" | "ready" | "deleting";
};

export function fileSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
