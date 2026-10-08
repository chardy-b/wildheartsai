// Runs the actual web-owned APIs and constrained-role repositories on a synthetic DB.
// There is no production auth bypass: the replacement auth module exists only in this
// separately built fixture; Next route handlers continue to import real Better Auth.
import { createServer, type RequestListener } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Db } from "../../src/lib/db/types";
import * as schema from "../../src/lib/db/schema";
import { sealField, userKeysFor } from "../../src/lib/crypto/user-keys";
import { browserRequest } from "../../src/lib/chat-web/browser-http";
import { workerRequest } from "../../src/lib/chat-web/worker-http";
import { assertChatDatabaseRoles } from "../../src/lib/chat-web/role-preflight";
import { webChatRuntime } from "../../src/lib/chat-web/runtime";

let startupPhase = "validate_synthetic_environment";
const diagnosticCodes = new Set([
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01", "23502", "23503", "23505", "23514",
  "28P01", "3D000", "42501", "57P01", "57P02", "57P03", "EACCES", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH",
  "ENETUNREACH", "ENOTFOUND", "ENOENT", "EPROTO", "ETIMEDOUT", "ERR_TLS_CERT_ALTNAME_INVALID",
]);
const diagnosticSlugs = new Set([
  "synthetic_database_required", "test_credential_required", "incomplete_test_tls", "chat_roles_not_restricted",
  "chat_role_has_memberships", "chat_role_excess_column_grant", "chat_role_missing_column_grant", "chat_role_excess_table_grant",
  "chat_role_missing_table_grant", "chat_rls_not_enabled", "chat_owner_policy_not_restricted", "chat_record_policy_not_restricted",
  "chat_unscoped_data_visible", "queue_rls_not_enabled", "queue_policy_not_provisioned", "chat_session_lock_not_restricted",
  "queue_role_must_be_separate", "chat_unavailable",
]);

function startupDiagnostic(error: unknown): { code: string; slug: string } {
  let code = "UNKNOWN";
  let slug = "UNKNOWN";
  let current: unknown = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 6 && current && typeof current === "object" && !seen.has(current); depth += 1) {
    seen.add(current);
    const item = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (code === "UNKNOWN" && typeof item.code === "string" && diagnosticCodes.has(item.code)) code = item.code;
    if (slug === "UNKNOWN" && typeof item.message === "string" && diagnosticSlugs.has(item.message)) slug = item.message;
    current = item.cause;
  }
  return { code, slug };
}

function reportPoolError(phase: string, error: unknown): void {
  const diagnostic = startupDiagnostic(error);
  console.error(`synthetic_web_fixture_failed phase=${phase} code=${diagnostic.code} slug=${diagnostic.slug}`);
}

async function verifySyntheticRoles(ownerUrl: string): Promise<void> {
  const owner = new URL(ownerUrl);
  const dataUrl = process.env.CHAT_DATABASE_URL;
  const queueUrl = process.env.CHAT_QUEUE_DATABASE_URL;
  if (!dataUrl || !queueUrl) throw new Error("synthetic_database_required");
  const data = new URL(dataUrl);
  const queue = new URL(queueUrl);
  if (data.hostname !== owner.hostname || queue.hostname !== owner.hostname || data.username !== "wildhearts_chat_data" || queue.username !== "wildhearts_chat_queue" || data.pathname !== "/chat" || queue.pathname !== "/chat") throw new Error("synthetic_database_required");
  const dataPool = new Pool({ connectionString: dataUrl, max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
  const queuePool = new Pool({ connectionString: queueUrl, max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
  dataPool.on("error", (error: Error) => reportPoolError("preflight_restricted_data_role", error));
  queuePool.on("error", (error: Error) => reportPoolError("preflight_restricted_queue_role", error));
  try { await assertChatDatabaseRoles(dataPool, queuePool); }
  finally { await Promise.all([dataPool.end(), queuePool.end()]); }
}

async function main() {
  const ownerUrl = process.env.DATABASE_URL_UNPOOLED;
  if (process.env.CHAT_TEST_ONLY !== "synthetic-accounts" || !ownerUrl || !/^whchat-test-[a-zA-Z0-9-]+-db$/.test(new URL(ownerUrl).hostname) || new URL(ownerUrl).username !== "postgres") throw new Error("synthetic_database_required");
  startupPhase = "connect_and_seed_synthetic_database";
  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  pool.on("error", (error: Error) => reportPoolError("connect_and_seed_synthetic_database", error));
  const db = drizzle(pool, { schema }) as unknown as Db;
  const now = new Date();
  try {
    for (const [person, number] of [["alice", "1"], ["bob", "2"]]) {
      const userId = `synthetic-${person}`;
      await db.insert(schema.user).values({ id: userId, name: `Synthetic ${person}`, email: `${person}@synthetic.example`, emailVerified: true, createdAt: now, updatedAt: now }).onConflictDoNothing();
      await db.insert(schema.session).values({ id: `synthetic-session-${person}`, token: `synthetic-unused-${person}`, userId, expiresAt: new Date(now.getTime() + 3600_000), createdAt: now, updatedAt: now }).onConflictDoNothing();
      const sourceId = `10000000-0000-4000-8000-00000000000${number}`;
      await db.insert(schema.healthSource).values({ id: sourceId, userId, vendor: "epic", fhirBaseUrl: "https://synthetic.example/R4", organizationName: "Synthetic organization", status: "disconnected", lastSyncStatus: "partial" }).onConflictDoNothing();
      const id = `20000000-0000-4000-8000-00000000000${number}`;
      const keys = await userKeysFor(db, Buffer.from(process.env.RECORDS_ENCRYPTION_KEY!, "base64"), userId, now);
      const resource = { resourceType: "Observation", id: `synthetic-${person}-observation`, status: "final", code: { text: "Synthetic lab" }, valueQuantity: { value: 1, unit: "synthetic" } };
      const summary = { title: "Synthetic lab", category: "lab", date: "2026-10-08" };
      await db.insert(schema.fhirResource).values({ id, userId, sourceId, resourceType: "Observation", fhirId: resource.id, category: "lab", contentHmac: `synthetic-version-${person}`, sealedResource: sealField(keys, JSON.stringify(resource), { table: "fhir_resource", field: "resource", rowId: id }), sealedSummary: sealField(keys, JSON.stringify(summary), { table: "fhir_resource", field: "summary", rowId: id }), normalizerVersion: 2, firstSeenAt: now, lastSeenAt: now }).onConflictDoNothing();
    }
    const credential = process.env.CHAT_COORDINATOR_CREDENTIAL;
    if (!credential || !/^[A-Za-z0-9_-]{43,128}$/.test(credential)) throw new Error("test_credential_required");
    await db.insert(schema.chatCoordinator).values({ credentialHash: createHash("sha256").update(credential).digest("hex") }).onConflictDoNothing();
  } finally { await pool.end(); }
  startupPhase = "preflight_restricted_data_and_queue_roles";
  await verifySyntheticRoles(ownerUrl);
  startupPhase = "initialize_web_authority";
  const runtime = await webChatRuntime();
  const reaper = setInterval(() => { void runtime.authority.reap().catch(() => {}); }, 2_000);
  reaper.unref();
  const handle: RequestListener = (incoming, outgoing) => {
    void (async () => {
      const origin = process.env.CHAT_TEST_WEB_ORIGIN!;
      const url = new URL(incoming.url ?? "/", origin);
      if (url.pathname === "/health") { outgoing.writeHead(200); outgoing.end("ready"); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of incoming) { size += chunk.length; if (size > 64 * 1024) { outgoing.writeHead(413); outgoing.end(); return; } chunks.push(chunk); }
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const request = new Request(url, { method: incoming.method, headers, ...(!["GET", "HEAD"].includes(incoming.method ?? "GET") && size ? { body: Buffer.concat(chunks) } : {}) });
      const prefix = url.pathname.startsWith("/api/chat/worker/v1/") ? "/api/chat/worker/v1/" : "/api/chat/v1/";
      if (!url.pathname.startsWith(prefix)) { outgoing.writeHead(404); outgoing.end(); return; }
      const path = url.pathname.slice(prefix.length).split("/");
      const reply = prefix.includes("worker") ? await workerRequest(request, path) : await browserRequest(request, path);
      outgoing.writeHead(reply.status, Object.fromEntries(reply.headers));
      outgoing.end(Buffer.from(await reply.arrayBuffer()));
    })().catch(() => { if (!outgoing.headersSent) outgoing.writeHead(503); outgoing.end(); });
  };
  const tlsKey = process.env.CHAT_TEST_TLS_KEY;
  const tlsCertificate = process.env.CHAT_TEST_TLS_CERT;
  if (!!tlsKey !== !!tlsCertificate) throw new Error("incomplete_test_tls");
  startupPhase = tlsKey ? "read_test_tls_material" : "start_test_http_listener";
  const server = tlsKey && tlsCertificate ? createTlsServer({ key: await readFile(tlsKey), cert: await readFile(tlsCertificate) }, handle) : createServer(handle);
  startupPhase = tlsKey ? "listen_with_test_tls" : "listen_test_http";
  server.once("error", (error: NodeJS.ErrnoException) => {
    reportPoolError(startupPhase, error);
    process.exit(1);
  });
  server.listen(8080, "0.0.0.0");
  process.once("SIGTERM", () => { clearInterval(reaper); server.close(); });
}
main().catch((error: unknown) => {
  reportPoolError(startupPhase, error);
  process.exit(1);
});
