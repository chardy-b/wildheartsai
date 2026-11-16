import { Hono, type Context } from "hono";
import { z } from "zod";
import { FAILURE_CODES } from "@/lib/extraction/failures";
import { auditStatement } from "../data/audit";
import { streamFile } from "../data/documents";
import { fileObjects } from "../data/file-objects";
import {
  authorized,
  backfill,
  cancel,
  claim,
  configured,
  DocumentFhirError,
  enabledMethods,
  enqueue,
  extractionAudit,
  fail,
  fileCoverage,
  finish,
  hash,
  listRuns,
  loadDocumentFhir,
  processingProgress,
  references,
  rerun,
  saveReference,
  workerConfig,
} from "../data/extraction";
import { forUser } from "../data/scope";
import { userKeysFor } from "../data/user-keys";
import { database } from "../db";
import { secrets } from "../env";
import { recordsKey } from "../epic/credentials";
import { authFor } from "../auth";
import type { AppEnv } from "../session";

// Document extraction (src/lib/extraction/http.ts and fhir-http.ts in the Next app): the owner's
// workbench requests, the VPS workers' attempt API, and a document's FHIR view. Same paths,
// checks and messages. Workers authenticate with the coordinator credential (to claim) or an
// attempt grant (everything else); neither reaches anything but that attempt.
export const extractionRoutes = new Hono<AppEnv>();

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", Pragma: "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const fileError = (message: string, status: number) => Response.json({ error: message }, { status, headers: PRIVATE_HEADERS });
const json = (value: unknown) => Response.json(value, { headers: PRIVATE_HEADERS });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_LIMIT = 3 * 1024 * 1024;

function sameOrigin(request: Request): boolean {
  return request.headers.get("origin") === new URL(request.url).origin && !["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "");
}

async function body(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > BODY_LIMIT) throw new Error("too_large");
  return JSON.parse(text);
}

async function signedIn(c: Context<AppEnv>) {
  return authFor(c.env).api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
}

const workbench = async (c: Context<AppEnv>) => {
  const request = c.req.raw;
  if (request.method !== "GET" && !sameOrigin(request)) return fileError("Request must come from this app.", 403);
  const session = await signedIn(c);
  if (!session) return fileError("Sign in to use the workbench.", 401);
  const config = secrets(c.env);
  const kek = recordsKey(config);
  const db = database(c.env.DB);
  const scope = forUser(db, session.user.id);
  try {
    if (request.method === "GET") {
      const query = new URL(request.url).searchParams;
      const fileId = query.get("fileId") ?? undefined;
      const resultId = query.get("resultId") ?? undefined;
      const referenceId = query.get("referenceId") ?? undefined;
      if (query.get("overview") === "1") return json(await processingProgress(scope));
      if (query.get("benchmark") === "1") return json(await extractionAudit(scope, kek));
      if (query.get("coverage") === "1") {
        const ids = query.getAll("fileId");
        if (!ids.length || ids.length > 50 || ids.some((id) => !UUID.test(id)) || (query.get("details") === "1" && ids.length !== 1)) return fileError("Not found.", 404);
        return json(await fileCoverage(scope, kek, [...new Set(ids)], query.get("details") === "1"));
      }
      if ([fileId, resultId, referenceId].some((id) => id && !UUID.test(id))) return fileError("Not found.", 404);
      return json({
        available: configured(config),
        methods: enabledMethods(config),
        runs: await listRuns(scope, kek, fileId, resultId),
        references: fileId ? await references(scope, kek, fileId, resultId ? undefined : referenceId) : [],
      });
    }
    const input = await body(request);
    if (request.method === "DELETE") {
      const { id } = z.object({ id: z.uuid() }).strict().parse(input);
      return json({ cancelled: await cancel(scope, id) });
    }
    if (request.method === "PUT") {
      const { fileId, labels } = z.object({ fileId: z.uuid(), labels: z.unknown() }).strict().parse(input);
      return json({ id: await saveReference(scope, kek, fileId, labels) });
    }
    if (!configured(config)) return fileError("Document workers are not configured yet.", 503);
    if (input && typeof input === "object" && "backfill" in input) {
      const { resumeCancelled } = z.object({ backfill: z.literal(true), resumeCancelled: z.boolean().optional().default(false) }).strict().parse(input);
      return json(await backfill(c.env, config, scope, kek, session.session.id, resumeCancelled));
    }
    if (input && typeof input === "object" && "rerunOf" in input) {
      const { rerunOf } = z.object({ rerunOf: z.uuid() }).strict().parse(input);
      return json({ ids: await rerun(c.env, config, scope, kek, session.session.id, rerunOf) });
    }
    return json({ ids: await enqueue(c.env, config, scope, kek, session.session.id, input) });
  } catch {
    return fileError("Could not complete the workbench request. Check your selections and try again.", 400);
  }
};
extractionRoutes.on(["GET", "POST", "PUT", "DELETE"], "/extraction", workbench);

extractionRoutes.on(["GET", "POST"], "/extraction/worker/v1/*", async (c) => {
  const config = secrets(c.env);
  if (!configured(config)) return fileError("Unavailable.", 503);
  const request = c.req.raw;
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const db = database(c.env.DB);
  const kek = recordsKey(config);
  try {
    const operation = new URL(request.url).pathname.replace(/^\/api\/extraction\/worker\/v1\//, "");
    if (operation === "claim" && request.method === "POST") {
      if (hash(token) !== config.EXTRACTION_COORDINATOR_TOKEN_HASH) return fileError("Unauthorized.", 401);
      const { requestId, pipeline } = z.object({ requestId: z.uuid(), pipeline: z.literal("native-ocr/v1").optional() }).strict().parse(await body(request));
      return json({ run: await claim(c.env, db, requestId, config.EXTRACTION_GRANT_KEY!, pipeline === "native-ocr/v1") });
    }
    if (operation === "config" && request.method === "GET") return json(await workerConfig(db, kek, token));
    if (operation === "status" && request.method === "GET") return json({ status: (await authorized(db, token, true)).job.status });
    if (operation === "source" && request.method === "GET") {
      const { run, scope } = await authorized(db, token);
      const file = await streamFile(scope, await userKeysFor(scope, kek, new Date()), run.fileId, fileObjects(c.env.FILES));
      if (!file) return fileError("Unavailable.", 404);
      await authorized(db, token);
      // Each encrypted piece is authenticated before its plaintext is streamed.
      return new Response(file.stream, { headers: { ...PRIVATE_HEADERS, "Content-Type": file.type } });
    }
    if (operation === "finish" && request.method === "POST") {
      await finish(db, kek, token, await body(request));
      return json({ ok: true });
    }
    if (operation === "fail" && request.method === "POST") {
      const { retryable, code } = z.object({ retryable: z.boolean().optional().default(false), code: z.enum(FAILURE_CODES).optional() }).strict().parse(await body(request));
      await fail(db, token, retryable, code);
      return json({ ok: true });
    }
    return fileError("Not found.", 404);
  } catch {
    return fileError("Run unavailable or invalid request.", 403);
  }
});

// A document's draft FHIR Bundle, inline or as a download (audited, counts only).
extractionRoutes.get("/wildcards/:id/fhir", async (c) => {
  const session = await signedIn(c);
  if (!session) return fileError("Sign in to view this document.", 401);
  const id = c.req.param("id");
  const runId = c.req.query("runId");
  if (!UUID.test(id) || (runId !== undefined && !UUID.test(runId))) return fileError("Document not found.", 404);
  const config = secrets(c.env);
  const scope = forUser(database(c.env.DB), session.user.id);
  try {
    const data = await loadDocumentFhir(scope, recordsKey(config), id, config.BETTER_AUTH_URL, runId);
    if (!data) return fileError("Document not found.", 404);
    const download = c.req.query("download") === "1";
    if (download) await auditStatement(scope, { action: "export", detail: { records: data.preview.bundle.entry.length, document: true } }, new Date());
    return new Response(JSON.stringify(data.preview.bundle, null, 2), {
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": "application/fhir+json; charset=utf-8",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="document-${id}.fhir.json"`,
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch (error) {
    if (error instanceof DocumentFhirError) return fileError(error.message, error.status);
    return fileError("Could not create this document’s FHIR view. Please try again.", 500);
  }
});

// The FHIR view page (a server component in the web Worker) needs the whole loaded view.
extractionRoutes.get("/wildcards/:id/fhir-view", async (c) => {
  const session = await signedIn(c);
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const id = c.req.param("id");
  const runId = c.req.query("runId");
  if (!UUID.test(id) || (runId !== undefined && !UUID.test(runId))) return c.json({ error: "not_found" }, 404);
  const config = secrets(c.env);
  try {
    const data = await loadDocumentFhir(forUser(database(c.env.DB), session.user.id), recordsKey(config), id, config.BETTER_AUTH_URL, runId);
    return data ? c.json(data, 200, PRIVATE_HEADERS) : c.json({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof DocumentFhirError) return c.json({ error: error.message, status: error.status }, 409);
    throw error;
  }
});
