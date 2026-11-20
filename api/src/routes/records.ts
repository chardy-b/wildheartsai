import { Hono } from "hono";
import { exportBundle, exportFilename } from "@/lib/export";
import { readNote } from "@/lib/records-notes";
import { sourceProblems } from "@/lib/source-display";
import { fhirRead } from "@/lib/fhir/client";
import { encodeCursor, hasFilters, parseCursor, parseFilters } from "@/lib/timeline-filters";
import { userKeysFor } from "../data/user-keys";
import { auditStatement } from "../data/audit";
import { isDemoIdentity } from "@/lib/demo/identity";
import { getConnectionForSource } from "../data/connections";
import { allMatching, allNotes, storedNoteText, timelinePage } from "../data/records";
import type { UserScope } from "../data/scope";
import { listSources, needingFirstSync, type SourceSummary } from "../data/sources";
import { requestSync } from "../data/sync-runs";
import { secrets, type Bindings } from "../env";
import { recordsKey, tokenKey } from "../epic/credentials";
import { accessTokenFor } from "../epic/token-refresher";
import { requireUser, type AppEnv } from "../session";
import { sendTo } from "../sync-queue";

// Reading stored records (src/lib/records-server.ts and the export route in the Next app). Every
// query goes through the signed-in person's scope.
export const recordsRoutes = new Hono<AppEnv>();
recordsRoutes.use("/sources", requireUser("json"));
recordsRoutes.use("/records/*", requireUser("json"));
recordsRoutes.use("/records", requireUser("json"));
recordsRoutes.use("/export", requireUser("json"));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The query string as the Next pages pass it: org, type (repeatable), from, to, before.
function queryParams(url: string): Record<string, string[]> {
  const search = new URL(url).searchParams;
  return Object.fromEntries([...new Set(search.keys())].map((key) => [key, search.getAll(key)]));
}

// Queues a first sync for connected sources that never had one. Returns whether any were queued.
async function startFirstSyncs(env: Bindings, scope: UserScope, sources: SourceSummary[]): Promise<boolean> {
  const outcomes = await Promise.all(
    needingFirstSync(sources).map((s) =>
      requestSync(scope, { sourceId: s.id, trigger: "connect" }, sendTo(env), new Date()).catch((error: unknown) => {
        console.error("[sync] queueing failed", error instanceof Error ? error.name : "unknown");
        return "not_connected" as const;
      }),
    ),
  );
  return outcomes.includes("queued");
}

recordsRoutes.get("/sources", async (c) => c.json({ sources: await listSources(c.get("scope")) }, 200, { "Cache-Control": "no-store" }));

// One page of stored records, plus what the person should know about their sources.
recordsRoutes.get("/records", async (c) => {
  const scope = c.get("scope");
  const params = queryParams(c.req.url);
  let sources = await listSources(scope);
  if (await startFirstSyncs(c.env, scope, sources)) sources = await listSources(scope);
  const filters = parseFilters(params, sources);
  const keys = await userKeysFor(scope, recordsKey(secrets(c.env)), new Date());
  const page = await timelinePage(scope, keys, sources, filters, parseCursor(params.before));
  // Only visits use `related`, to list their notes; the page's own notes are already there.
  const related = page.items.some((i) => i.category === "visit") ? await allNotes(scope, keys, sources) : [];
  return c.json(
    { sources, filters, items: page.items, related, next: page.next ? encodeCursor(page.next) : null, problems: sourceProblems(sources) },
    200,
    { "Cache-Control": "no-store" },
  );
});

// A note's text: the stored copy when there is one (so it works for disconnected sources too),
// else read live through the source's connection. The address must be inside the source's FHIR
// base (checked in fhirRead).
recordsRoutes.get("/records/note", async (c) => {
  const sourceId = c.req.query("sourceId") ?? "";
  const url = c.req.query("url") ?? "";
  if (!UUID.test(sourceId) || !url || url.length > 2048) return c.json({ ok: false, reason: "not_found" });
  const scope = c.get("scope");
  const config = secrets(c.env);
  const keys = await userKeysFor(scope, recordsKey(config), new Date());
  const stored = await storedNoteText(scope, keys, sourceId, url);
  if (stored !== undefined) return c.json(stored === null ? { ok: false, reason: "unsupported" } : { ok: true, text: stored });
  const connection = await getConnectionForSource(scope, tokenKey(config), sourceId);
  if (!connection) return c.json({ ok: false, reason: "not_found" });
  return c.json(
    await readNote(
      { connections: [connection], connectionId: connection.id, attachmentUrl: url },
      { accessToken: (conn) => accessTokenFor(c.env, scope.userId, conn), read: (input) => fhirRead(input) },
    ),
  );
});

// The records the timeline filters select, as a FHIR Bundle download.
recordsRoutes.get("/export", async (c) => {
  const scope = c.get("scope");
  const sources = await listSources(scope);
  const filters = parseFilters(queryParams(c.req.url), sources);
  const keys = await userKeysFor(scope, recordsKey(secrets(c.env)), new Date());
  const items = await allMatching(scope, keys, sources, filters);
  const now = new Date();
  // Not for the shared demo chart: nothing a demo viewer does is stored.
  if (!isDemoIdentity(scope.userId)) await auditStatement(scope, { action: "export", detail: { records: items.length, filtered: hasFilters(filters) } }, now);
  return new Response(JSON.stringify(exportBundle(items, sources, now), null, 2), {
    headers: {
      "Content-Type": "application/fhir+json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(filters, now)}"`,
      "Cache-Control": "private, no-store",
    },
  });
});
