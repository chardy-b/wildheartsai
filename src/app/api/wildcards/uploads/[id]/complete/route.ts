import { db } from "@/lib/db";
import { recordsKey } from "@/lib/records-keys";
import { completeUpload, FileInputError } from "@/lib/wildcards-store";
import { PRIVATE_HEADERS, validFileId } from "@/lib/wildcards-http";
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
    const result = await completeUpload(db, recordsKey(), user, id, fileObjects());
    return Response.json({ ok: true, ...result }, { headers: PRIVATE_HEADERS });
  } catch (error) { return uploadError(error); }
}
