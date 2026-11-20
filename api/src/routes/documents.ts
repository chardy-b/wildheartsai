import { Hono, type Context } from "hono";
import { documentsPage, UPLOAD_CHUNK_BYTES } from "@/lib/wildcards";
import { beginUpload, cleanupExpiredUploads, completeUpload, deleteFile, FileInputError, fileMetadata, fileUsage, listFiles, storeFile, streamFile, uploadPart } from "../data/documents";
import { fileObjects } from "../data/file-objects";
import { userKeysFor } from "../data/user-keys";
import { secrets } from "../env";
import { recordsKey } from "../epic/credentials";
import { clientIp, rateLimited } from "../limits";
import { notGuest, requireUser, type AppEnv } from "../session";

// Documents (src/app/api/wildcards/* in the Next app): the same paths, checks and messages, which
// the upload client (src/lib/wildcards-client.ts) shows to people. Files go to R2 through the FILES
// binding; nothing is logged about a file but an error class.
export const documentRoutes = new Hono<AppEnv>();

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", Pragma: "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const fileError = (message: string, status: number) => Response.json({ error: message }, { status, headers: PRIVATE_HEADERS });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Writes must come from the app's own pages.
function sameOrigin(request: Request): boolean {
  return request.headers.get("origin") === new URL(request.url).origin && !["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "");
}

// A bounded raw body rather than an arbitrary multipart request. Each file in a selection, and
// each piece of a large file, comes in its own request.
async function readUpload(request: Request): Promise<Buffer> {
  if (Number(request.headers.get("content-length")) > UPLOAD_CHUNK_BYTES) throw new FileInputError("An upload piece exceeded the transfer limit. Refresh Documents and try again.");
  const reader = request.body?.getReader();
  if (!reader) throw new FileInputError("Choose a nonempty file.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > UPLOAD_CHUNK_BYTES) {
        await reader.cancel();
        throw new FileInputError("An upload piece exceeded the transfer limit. Refresh Documents and try again.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function uploadError(error: unknown): Response {
  if (error instanceof FileInputError) return fileError(error.message, error.status);
  console.error("[documents] upload failed", error instanceof Error ? error.name : "unknown");
  return fileError("We could not save this upload. Your file has not been confirmed as uploaded. Check your connection and file list before trying again.", 500);
}

const kek = (c: Context<AppEnv>) => recordsKey(secrets(c.env));
const objects = (c: Context<AppEnv>) => fileObjects(c.env.FILES);

// Uploads check the origin before the session, as before.
const fromApp = (message: string) => async (c: Context<AppEnv>, next: () => Promise<void>) => {
  if (!sameOrigin(c.req.raw)) return fileError(message, 403);
  await next();
};

// For the Documents pages (server components in the web Worker): a page of the listing and usage,
// and one file's details.
documentRoutes.get("/wildcards", requireUser("json"), async (c) => {
  const scope = c.get("scope");
  const usage = await fileUsage(scope);
  const page = documentsPage(Number(c.req.query("page")), usage.count);
  return c.json({ files: await listFiles(scope, kek(c), page), usage, page }, 200, PRIVATE_HEADERS);
});

documentRoutes.get("/wildcards/:id/info", requireUser("json"), async (c) => {
  const id = c.req.param("id");
  const file = UUID.test(id) ? await fileMetadata(c.get("scope"), kek(c), id) : null;
  return file ? c.json({ file }, 200, PRIVATE_HEADERS) : fileError("File not found.", 404);
});

// Starting a file: guests can't, and everyone else is limited per person and per network.
// A large file's pieces belong to one start, so they aren't counted.
const uploadAllowed = [
  notGuest(() => fileError("Create a free account to upload your own documents. The demo uses a fictional sample.", 403)),
  rateLimited<AppEnv>((c) => [["uploadPerPerson", c.get("userId")], ["uploadPerIp", clientIp(c.req.raw.headers)]], "Too many uploads in the last hour. Try again later."),
] as const;

documentRoutes.post("/wildcards", fromApp("Upload must come from this app."), requireUser({ message: "Sign in to upload files." }), ...uploadAllowed, async (c) => {
  if (c.req.header("content-type") !== "application/octet-stream") return fileError("Unsupported upload request.", 415);
  try {
    let name: string;
    try {
      name = decodeURIComponent(c.req.header("x-file-name") ?? "");
    } catch {
      throw new FileInputError("Invalid filename.");
    }
    await storeFile(c.get("scope"), kek(c), name, await readUpload(c.req.raw), objects(c));
    return Response.json({ ok: true }, { status: 201, headers: PRIVATE_HEADERS });
  } catch (error) {
    if (error instanceof FileInputError) return fileError(error.message, error.status);
    // Never log filenames, file contents, or database errors containing them.
    return fileError("Could not save this file. Please try again.", 500);
  }
});

documentRoutes.post("/wildcards/uploads", fromApp("Uploads must come from Documents in this app."), requireUser({ message: "Your session has expired. Sign in again, then upload your file." }), ...uploadAllowed, async (c) => {
  try {
    if (c.req.header("content-type") !== "application/json") throw new FileInputError("Invalid upload request.");
    const bytes = await readUpload(c.req.raw);
    if (bytes.length > 4096) throw new FileInputError("Invalid upload request.");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new FileInputError("Invalid upload request.");
    }
    if (!body || typeof body !== "object" || typeof body.name !== "string" || typeof body.size !== "number") throw new FileInputError("The file name or size could not be read. Choose the file again.");
    if ("relativePath" in body && typeof body.relativePath !== "string") throw new FileInputError("The file path could not be read. Choose the folder again.");
    if ("id" in body && (typeof body.id !== "string" || !UUID.test(body.id))) throw new FileInputError("Invalid upload ID.");
    if ("sha256" in body && (typeof body.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.sha256))) throw new FileInputError("Invalid file fingerprint.");
    const scope = c.get("scope");
    await cleanupExpiredUploads(scope, objects(c));
    const result = await beginUpload(
      scope,
      kek(c),
      { name: body.name, size: body.size, relativePath: body.relativePath as string | undefined, requestId: body.id as string | undefined, sha256: body.sha256 as string | undefined },
      objects(c),
    );
    return Response.json(result, { status: 201, headers: PRIVATE_HEADERS });
  } catch (error) {
    return uploadError(error);
  }
});

documentRoutes.put("/wildcards/uploads/:id/:part", fromApp("Uploads must come from Documents in this app."), requireUser({ message: "Your session has expired. Sign in again, then upload your file." }), async (c) => {
  try {
    const { id, part } = c.req.param();
    if (!UUID.test(id) || !/^\d{1,2}$/.test(part)) throw new FileInputError("Upload not found. Choose the file again.", 404);
    if (c.req.header("content-type") !== "application/octet-stream") throw new FileInputError("Invalid upload piece.");
    await uploadPart(c.get("scope"), kek(c), id, Number(part), await readUpload(c.req.raw), objects(c));
    return new Response(null, { status: 204, headers: PRIVATE_HEADERS });
  } catch (error) {
    return uploadError(error);
  }
});

documentRoutes.post("/wildcards/uploads/:id/complete", fromApp("Uploads must come from Documents in this app."), requireUser({ message: "Your session has expired. Sign in again, then upload your file." }), async (c) => {
  try {
    const id = c.req.param("id");
    if (!UUID.test(id)) throw new FileInputError("Upload not found. Choose the file again.", 404);
    const result = await completeUpload(c.get("scope"), kek(c), id, objects(c));
    return Response.json({ ok: true, ...result }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return uploadError(error);
  }
});

documentRoutes.get("/wildcards/:id", requireUser({ message: "Sign in to access files." }), async (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return fileError("File not found.", 404);
  try {
    const scope = c.get("scope");
    const file = await streamFile(scope, await userKeysFor(scope, kek(c), new Date()), id, objects(c));
    if (!file) return fileError("File not found.", 404);
    const disposition = c.req.query("download") === "1" ? "attachment" : "inline";
    const filename = encodeURIComponent(file.name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
    return new Response(file.stream, {
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": file.type,
        "Content-Disposition": `${disposition}; filename="download"; filename*=UTF-8''${filename}`,
        // Uploaded documents never inherit the app's script privileges.
        "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch {
    return fileError("Could not open this file. Please try again.", 500);
  }
});

documentRoutes.delete("/wildcards/:id", fromApp("Delete must come from this app."), requireUser({ message: "Sign in to delete files." }), async (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return fileError("File not found.", 404);
  try {
    if (!(await deleteFile(c.get("scope"), id, objects(c)))) return fileError("File not found.", 404);
    return new Response(null, { status: 204, headers: PRIVATE_HEADERS });
  } catch {
    return fileError("Could not delete this file. Please try again.", 500);
  }
});
