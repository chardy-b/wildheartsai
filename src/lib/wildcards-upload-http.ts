import "server-only";
import { getSession } from "./session";
import { fileError, sameOrigin } from "./wildcards-http";
import { r2Configured } from "./wildcards-r2";
import { FileInputError } from "./wildcards-store";

export async function uploadUser(request: Request): Promise<string | Response> {
  if (!sameOrigin(request)) return fileError("Uploads must come from Documents in this app.", 403);
  const session = await getSession();
  if (!session) return fileError("Your session has expired. Sign in again, then upload your file.", 401);
  if (!r2Configured()) return fileError("Document storage is temporarily unavailable. Please try again later.", 503);
  return session.user.id;
}

export function uploadError(error: unknown): Response {
  return error instanceof FileInputError ? fileError(error.message, error.status) :
    fileError("We could not save this upload. Your file has not been confirmed as uploaded. Check your connection and file list before trying again.", 500);
}
