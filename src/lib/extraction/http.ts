import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";
import { recordsKey } from "@/lib/records-keys";
import { getSession } from "@/lib/session";
import { fileError, PRIVATE_HEADERS, readUpload, sameOrigin, validFileId } from "@/lib/wildcards-http";
import { fileObjects } from "@/lib/wildcards-r2";
import { readFile } from "@/lib/wildcards-store";
import { authorized, cancel, claim, configured, enabledMethods, enqueue, fail, finish, hash, listRuns, references, saveReference, workerConfig } from "./store";

const json = (value: unknown) => Response.json(value, { headers: PRIVATE_HEADERS });
async function body(request: Request) { return JSON.parse((await readUpload(request)).toString("utf8")) as unknown; }
export async function browserRequest(request: Request) {
  if (request.method !== "GET" && !sameOrigin(request)) return fileError("Request must come from this app.", 403);
  const session = await getSession();
  if (!session) return fileError("Sign in to use the workbench.", 401);
  try {
    if (request.method === "GET") {
      const query = new URL(request.url).searchParams, fileId = query.get("fileId") ?? undefined, resultId = query.get("resultId") ?? undefined, referenceId = query.get("referenceId") ?? undefined;
      if ([fileId, resultId, referenceId].some(id => id && !validFileId(id))) return fileError("Not found.", 404);
      return json({ available: configured(), methods: enabledMethods(), runs: await listRuns(db, recordsKey(), session.user.id, fileId, resultId), references: fileId ? await references(db, recordsKey(), session.user.id, fileId, resultId ? undefined : referenceId) : [] });
    }
    const input = await body(request);
    if (request.method === "DELETE") {
      const { id } = z.object({ id: z.uuid() }).strict().parse(input);
      return json({ cancelled: await cancel(db, session.user.id, id) });
    }
    if (request.method === "PUT") {
      const { fileId, labels } = z.object({ fileId: z.uuid(), labels: z.unknown() }).strict().parse(input);
      return json({ id: await saveReference(db, recordsKey(), session.user.id, fileId, labels) });
    }
    if (!configured()) return fileError("Document workers are not configured yet.", 503);
    return json({ ids: await enqueue(db, recordsKey(), session.user.id, session.session.id, input) });
  } catch { return fileError("Could not complete the workbench request. Check your selections and try again.", 400); }
}

export async function workerRequest(request: Request, path: string[]) {
  if (!configured()) return fileError("Unavailable.", 503);
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  try {
    const operation = path.join("/");
    if (operation === "claim" && request.method === "POST") {
      if (hash(token) !== process.env.EXTRACTION_COORDINATOR_TOKEN_HASH) return fileError("Unauthorized.", 401);
      const { requestId } = z.object({ requestId: z.uuid() }).strict().parse(await body(request));
      return json({ run: await claim(db, requestId, process.env.EXTRACTION_GRANT_KEY!) });
    }
    if (operation === "config" && request.method === "GET") return json(await workerConfig(db, recordsKey(), token));
    if (operation === "status" && request.method === "GET") return json({ status: (await authorized(db, token, true)).job.status });
    if (operation === "source" && request.method === "GET") {
      const { job, run } = await authorized(db, token);
      const file = await readFile(db, recordsKey(), job.userId, run.fileId, fileObjects());
      if (!file) return fileError("Unavailable.", 404);
      await authorized(db, token);
      // Authenticate complete ciphertext before streaming plaintext; never disclose filenames.
      let offset = 0;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (offset >= file.bytes.length) { controller.close(); return; }
        const end = Math.min(offset + 64 * 1024, file.bytes.length);
        controller.enqueue(new Uint8Array(file.bytes.subarray(offset, end))); offset = end;
      } }), { headers: { ...PRIVATE_HEADERS, "Content-Type": file.type } });
    }
    if (operation === "finish" && request.method === "POST") { await finish(db, recordsKey(), token, await body(request)); return json({ ok: true }); }
    if (operation === "fail" && request.method === "POST") {
      const { retryable } = z.object({ retryable: z.boolean().optional().default(false) }).strict().parse(await body(request));
      await fail(db, token, retryable); return json({ ok: true });
    }
    return fileError("Not found.", 404);
  } catch { return fileError("Run unavailable or invalid request.", 403); }
}
