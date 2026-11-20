import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { DEMO_NAME, DEMO_SOURCES, DEMO_USER_ID, buildDemoScenario, demoDocumentEntries, type DemoEntry } from "@/lib/demo/scenario";
import { describeResource } from "@/lib/fhir/describe";
import { CONSENT_VERSION } from "@/lib/onboarding";
import { diffResources } from "@/lib/sync/diff";
import { SYNC_QUERIES, type SyncQuery } from "@/lib/sync/plan";
import { fhirResource, healthSource, profile, syncRun, user } from "../db/schema";
import type { Db } from "../db";
import type { Bindings } from "../env";
import { applyDiff, currentRows, prepareFetched } from "../jobs/sync/store";
import { storeNote } from "../jobs/sync/notes";
import { withLock } from "../locks";
import { openStoredRow } from "./records";
import { forUser, inJson, system, type UserScope } from "./scope";
import { userKeysFor } from "./user-keys";

// The guided demo on Cloudflare: one central, fictional chart that everyone views, and nothing
// created per visitor. The chart is the demo account (DEMO_USER_ID, which has no login), written
// once on first use through the real normalizers, diffing, encryption and note store: the base
// story and the sample PDF's records. Visitors get a demo identity that reads it (see
// `demoIdentity` and the read-only guard in src/session.ts); every walkthrough step answers from
// it without writing.

const baseUrl = (key: string) => `https://demo.invalid/${key}/FHIR/R4`;
// The fictional case uses Pacific calendar days, independent of a UTC server.
const referenceDate = (value: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);

// One query per (source, search) instead of per record keeps an import well under the
// per-invocation query limit.
async function importEntries(scope: UserScope, kek: Buffer, entries: DemoEntry[], now: Date) {
  const keys = await userKeysFor(scope, kek, now);
  const sources = await scope.select(healthSource);
  for (const source of DEMO_SOURCES) {
    const selected = entries.filter((e) => e.source === source.key);
    if (!selected.length) continue;
    let stored = sources.find((s) => s.fhirBaseUrl === baseUrl(source.key));
    if (!stored) {
      [stored] = await scope
        .insert(healthSource, { userId: scope.userId, vendor: "epic", fhirBaseUrl: baseUrl(source.key), organizationName: `${source.name} · fictional demo`, status: "disconnected", createdAt: now, updatedAt: now })
        .returning();
    }
    const groups = new Map<SyncQuery, DemoEntry[]>();
    for (const entry of selected) {
      const query = SYNC_QUERIES.find((q) => q.resourceType === entry.resource.resourceType && q.category === entry.category);
      if (!query) throw new Error("unsupported_demo_type");
      groups.set(query, [...(groups.get(query) ?? []), entry]);
    }
    let inserted = 0, unchanged = 0;
    for (const [query, group] of groups) {
      const existing = await currentRows(scope, stored.id, query, group.map((e) => e.resource.id!), false);
      const diff = diffResources(prepareFetched(keys, group.map((e) => e.resource)), existing, {});
      const counts = await applyDiff(scope, keys, { userId: scope.userId, sourceId: stored.id, organizationName: stored.organizationName, query }, diff, now);
      inserted += counts.inserted;
      unchanged += counts.unchanged;
      const notes = group.filter((e) => e.noteText);
      if (!notes.length) continue;
      const records = await scope.selectFields(fhirResource, { id: fhirResource.id, fhirId: fhirResource.fhirId },
        and(eq(fhirResource.sourceId, stored.id), inJson(fhirResource.fhirId, notes.map((e) => e.resource.id!)), isNull(fhirResource.supersededAt)));
      for (const entry of notes) {
        const record = records.find((r) => r.fhirId === entry.resource.id)!;
        await storeNote(scope, keys, { sourceId: stored.id, resourceId: record.id, url: `Binary/${entry.resource.id}`, contentType: "text/plain", raw: entry.noteText! }, now);
      }
    }
    // Bounded metadata history: repeat presentations do not grow an unbounded log.
    await scope.batch([
      scope.update(healthSource, { lastSyncedAt: now, lastSyncStatus: "ok", updatedAt: now }, eq(healthSource.id, stored.id)),
      scope.delete(syncRun, eq(syncRun.sourceId, stored.id)),
      scope.insert(syncRun, { userId: scope.userId, sourceId: stored.id, trigger: "manual", status: "ok", queuedAt: now, startedAt: now, finishedAt: now, stats: { "demo:fixture": { fetched: selected.length, inserted, unchanged, superseded: 0, removed: 0 } } }),
    ]);
  }
}

const DOCUMENTS = baseUrl("documents");

// Writes the central chart if it isn't there yet: one read when it is. Idempotent (the sync
// diff), so a retry after a failure only fills in what's missing.
export async function ensureDemoChart(env: Bindings, db: Db, kek: Buffer, now = new Date()): Promise<void> {
  const scope = forUser(db, DEMO_USER_ID);
  const complete = async () => (await scope.selectFields(healthSource, { url: healthSource.fhirBaseUrl }, inJson(healthSource.fhirBaseUrl, [baseUrl("primary"), DOCUMENTS]))).length === 2;
  if (await complete()) return;
  await withLock(env, "demo-chart", async () => {
    if (await complete()) return;
    const sys = system(db);
    await sys.batch([
      sys.insert(user).values({ id: DEMO_USER_ID, name: `${DEMO_NAME} (fictional demo)`, email: "demo-chart@demo.invalid", emailVerified: true, createdAt: now, updatedAt: now }).onConflictDoNothing(),
      scope.insert(profile, { userId: DEMO_USER_ID, preferredName: "Alex (demo)", consentVersion: CONSENT_VERSION, consentedAt: now, onboardedAt: now }).onConflictDoNothing(),
    ]);
    const anchor = referenceDate(now);
    await importEntries(scope, kek, [...buildDemoScenario(anchor), ...demoDocumentEntries(anchor)], now);
  });
}

// The chart as the walkthrough shows it. The sample PDF's records are stored with the rest, and
// shown once the visitor has done the PDF step (`document`), which the page keeps track of.
export async function demoSnapshot(db: Db, kek: Buffer, options: { document: boolean }) {
  const scope = forUser(db, DEMO_USER_ID);
  const urls = DEMO_SOURCES.map((s) => baseUrl(s.key)).filter((url) => options.document || url !== DOCUMENTS);
  const sources = await scope.select(healthSource, inJson(healthSource.fhirBaseUrl, urls));
  const primary = sources.find((s) => s.fhirBaseUrl === baseUrl("primary"));
  if (!primary) return null;
  const keys = await userKeysFor(scope, kek, new Date());
  const rows = await scope.select(fhirResource, and(inJson(fhirResource.sourceId, sources.map((s) => s.id)), isNull(fhirResource.supersededAt), isNull(fhirResource.removedAt))).limit(200);
  return {
    anchor: referenceDate(primary.createdAt),
    sources: sources.map((source) => ({ id: source.id, key: DEMO_SOURCES.find((s) => baseUrl(s.key) === source.fhirBaseUrl)!.key, name: source.organizationName, syncedAt: source.lastSyncedAt?.toISOString() ?? null, count: rows.filter((r) => r.sourceId === source.id).length })),
    records: rows.map((row) => {
      const opened = openStoredRow(keys, row);
      return { id: row.id, sourceId: row.sourceId, fhirId: row.fhirId, category: row.category, resourceType: row.resourceType, title: opened.summary.title, detail: opened.summary.detail, date: opened.summary.date, resource: opened.resource, sections: describeResource(opened.resource) };
    }),
  };
}

// Who is viewing. A guest is a signed cookie (`<viewer id>.<expiry ms>.<signature>`) and nothing
// else: no row anywhere. A signed-in viewer is their login. The identity answered for both is the
// central chart's, marked `demo`, which the read-only guard refuses every write for.
export const GUEST_TTL_MS = 24 * 60 * 60 * 1000;
const viewerKey = (secret: string) => createHmac("sha256", secret).update("wildhearts-demo-viewer:v1").digest();
const sign = (secret: string, body: string) => createHmac("sha256", viewerKey(secret)).update(body).digest("base64url");

export function issueGuestViewer(secret: string, now = new Date()) {
  const expiresAt = new Date(now.getTime() + GUEST_TTL_MS);
  const body = `${randomBytes(16).toString("hex")}.${expiresAt.getTime()}`;
  return { cookie: `${body}.${sign(secret, body)}`, expiresAt };
}

export function guestViewer(secret: string, cookie: string | undefined, now = new Date()): { id: string; expiresAt: Date } | null {
  const match = /^([a-f0-9]{32})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(cookie ?? "");
  if (!match) return null;
  const expected = Buffer.from(sign(secret, `${match[1]}.${match[2]}`)), given = Buffer.from(match[3]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const expiresAt = new Date(Number(match[2]));
  return expiresAt > now ? { id: match[1], expiresAt } : null;
}

export type DemoViewer = { viewer: "guest" | "member"; viewerId: string };

export async function demoIdentity(db: Db, demo: DemoViewer, expiresAt: Date) {
  const [chart] = await system(db).select().from(user).where(eq(user.id, DEMO_USER_ID));
  if (!chart) return null;
  return { user: chart, session: { id: `demo_view_${demo.viewerId}`, userId: DEMO_USER_ID, expiresAt, createdAt: expiresAt }, demo };
}
