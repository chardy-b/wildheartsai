import { getSession } from "@/lib/session";
import { db } from "@/lib/db";
import { recordsKey } from "@/lib/records-keys";
import { deleteFile, readFile } from "@/lib/wildcards-store";
import { fileError, PRIVATE_HEADERS, sameOrigin, validFileId } from "@/lib/wildcards-http";
import { fileObjects } from "@/lib/wildcards-r2";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export const maxDuration = 120;

export async function GET(request: Request, context: Context) {
  const session = await getSession();
  if (!session) return fileError("Sign in to access files.", 401);
  const { id } = await context.params;
  if (!validFileId(id)) return fileError("File not found.", 404);
  try {
    const file = await readFile(db, recordsKey(), session.user.id, id, fileObjects());
    if (!file) return fileError("File not found.", 404);
    const disposition = new URL(request.url).searchParams.get("download") === "1" ? "attachment" : "inline";
    const filename = encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    // A real streaming response avoids Vercel's buffered response size limit.
    // Keep GCM authentication complete before releasing any plaintext.
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset >= file.bytes.length) { controller.close(); return; }
      const end = Math.min(offset + 64 * 1024, file.bytes.length);
      controller.enqueue(new Uint8Array(file.bytes.subarray(offset, end)));
      offset = end;
    } });
    return new Response(stream, { headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": file.type,
      "Content-Disposition": `${disposition}; filename="download"; filename*=UTF-8''${filename}`,
      // Uploaded documents never inherit the app's script privileges.
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'",
      "Cross-Origin-Resource-Policy": "same-origin",
    } });
  } catch { return fileError("Could not open this file. Please try again.", 500); }
}

export async function DELETE(request: Request, context: Context) {
  if (!sameOrigin(request)) return fileError("Delete must come from this app.", 403);
  const session = await getSession();
  if (!session) return fileError("Sign in to delete files.", 401);
  const { id } = await context.params;
  if (!validFileId(id)) return fileError("File not found.", 404);
  try {
    if (!await deleteFile(db, session.user.id, id, fileObjects())) return fileError("File not found.", 404);
    return new Response(null, { status: 204, headers: PRIVATE_HEADERS });
  } catch { return fileError("Could not delete this file. Please try again.", 500); }
}
