import { db } from "@/lib/db";
import { recordsKey } from "@/lib/records-keys";
import { completeUpload, FileInputError } from "@/lib/wildcards-store";
import { PRIVATE_HEADERS, readUpload, validFileId } from "@/lib/wildcards-http";
import { fileObjects } from "@/lib/wildcards-r2";
import { uploadError, uploadUser } from "@/lib/wildcards-upload-http";

export const runtime = "nodejs";
export const maxDuration = 120;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await uploadUser(request);
  if (user instanceof Response) return user;
  try {
    const { id } = await context.params;
    if (!validFileId(id)) throw new FileInputError("Upload not found. Choose the file again.", 404);
    let sha256: string | undefined;
    if (request.body && request.headers.get("content-type") === "application/json") {
      const bytes = await readUpload(request);
      if (bytes.length > 4096) throw new FileInputError("Invalid completion request.");
      if (bytes.length) {
        let body: unknown;
        try { body = JSON.parse(bytes.toString("utf8")); } catch { throw new FileInputError("Invalid completion request."); }
        if (!body || typeof body !== "object" || !("sha256" in body) || typeof body.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.sha256)) throw new FileInputError("Invalid file hash.");
        sha256 = body.sha256;
      }
    }
    const result = await completeUpload(db, recordsKey(), user, id, fileObjects(), sha256);
    return Response.json({ ok: true, ...result }, { headers: PRIVATE_HEADERS });
  } catch (error) { return uploadError(error); }
}
