import { db } from "@/lib/db";
import { recordsKey } from "@/lib/records-keys";
import { FileInputError, uploadPart } from "@/lib/wildcards-store";
import { PRIVATE_HEADERS, readUpload, validFileId } from "@/lib/wildcards-http";
import { fileObjects } from "@/lib/wildcards-r2";
import { uploadError, uploadUser } from "@/lib/wildcards-upload-http";

export const runtime = "nodejs";
export async function PUT(request: Request, context: { params: Promise<{ id: string; part: string }> }) {
  const user = await uploadUser(request);
  if (user instanceof Response) return user;
  try {
    const { id, part } = await context.params;
    if (!validFileId(id) || !/^\d{1,2}$/.test(part)) throw new FileInputError("Upload not found. Choose the file again.", 404);
    if (request.headers.get("content-type") !== "application/octet-stream") throw new FileInputError("Invalid upload piece.");
    await uploadPart(db, recordsKey(), user, id, Number(part), await readUpload(request), fileObjects());
    return new Response(null, { status: 204, headers: PRIVATE_HEADERS });
  } catch (error) { return uploadError(error); }
}
