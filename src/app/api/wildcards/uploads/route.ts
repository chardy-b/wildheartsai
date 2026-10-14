import { db } from "@/lib/db";
import { recordsKey } from "@/lib/records-keys";
import { beginUpload, cleanupExpiredUploads, FileInputError } from "@/lib/wildcards-store";
import { fileObjects } from "@/lib/wildcards-r2";
import { PRIVATE_HEADERS, readUpload, validFileId } from "@/lib/wildcards-http";
import { uploadError, uploadUser } from "@/lib/wildcards-upload-http";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const user = await uploadUser(request);
  if (user instanceof Response) return user;
  try {
    if (request.headers.get("content-type") !== "application/json") throw new FileInputError("Invalid upload request.");
    const bytes = await readUpload(request);
    if (bytes.length > 4096) throw new FileInputError("Invalid upload request.");
    let body: unknown;
    try { body = JSON.parse(bytes.toString("utf8")); } catch { throw new FileInputError("Invalid upload request."); }
    if (!body || typeof body !== "object" || !("name" in body) || typeof body.name !== "string" || !("size" in body) || typeof body.size !== "number") throw new FileInputError("The file name or size could not be read. Choose the file again.");
    if ("relativePath" in body && typeof body.relativePath !== "string") throw new FileInputError("The file path could not be read. Choose the folder again.");
    const relativePath = "relativePath" in body ? body.relativePath as string : undefined;
    const id = "id" in body ? body.id : undefined;
    if (id !== undefined && (typeof id !== "string" || !validFileId(id))) throw new FileInputError("Invalid upload ID.");
    await cleanupExpiredUploads(db, user, fileObjects());
    const result = id === undefined ? await beginUpload(db, recordsKey(), user, body.name, body.size, relativePath) : await beginUpload(db, recordsKey(), user, body.name, body.size, relativePath, id);
    return Response.json(result, { status: 201, headers: PRIVATE_HEADERS });
  } catch (error) { return uploadError(error); }
}
