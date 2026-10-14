import { getSession } from "@/lib/session";
import { db } from "@/lib/db";
import { recordsKey } from "@/lib/records-keys";
import { FileInputError, storeFile } from "@/lib/wildcards-store";
import { fileError, PRIVATE_HEADERS, readUpload, sameOrigin } from "@/lib/wildcards-http";
import { fileObjects, r2Configured } from "@/lib/wildcards-r2";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return fileError("Upload must come from this app.", 403);
  const session = await getSession();
  if (!session) return fileError("Sign in to upload files.", 401);
  if (!r2Configured()) return fileError("File uploads are not available yet. Please try again later.", 503);
  if (request.headers.get("content-type") !== "application/octet-stream") return fileError("Unsupported upload request.", 415);
  try {
    let name: string;
    try { name = decodeURIComponent(request.headers.get("x-file-name") ?? ""); }
    catch { throw new FileInputError("Invalid filename."); }
    const bytes = await readUpload(request);
    const result = await storeFile(db, recordsKey(), session.user.id, name, bytes, fileObjects());
    return Response.json({ ok: true, ...result }, { status: result.duplicate ? 200 : 201, headers: PRIVATE_HEADERS });
  } catch (error) {
    if (error instanceof FileInputError) return fileError(error.message, error.status);
    // Do not log filenames, file contents, or database errors containing them.
    return fileError("Could not save this file. Please try again.", 500);
  }
}
