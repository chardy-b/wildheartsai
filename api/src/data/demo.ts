import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, like, notExists } from "drizzle-orm";
import { DEMO_NAME, DEMO_SOURCES, buildDemoScenario, demoDocumentEntries, type DemoEntry } from "@/lib/demo/scenario";
import { DEMO_GUEST_PREFIX, demoUserId, isDemoIdentity, isGuestDemoIdentity } from "@/lib/demo/identity";
import { describeResource } from "@/lib/fhir/describe";
import { CONSENT_VERSION } from "@/lib/onboarding";
import { diffResources } from "@/lib/sync/diff";
import { SYNC_QUERIES, type SyncQuery } from "@/lib/sync/plan";
import { fhirResource, healthSource, profile, session, syncRun, user } from "../db/schema";
import type { Db } from "../db";
import type { Bindings } from "../env";
import { applyDiff, currentRows, prepareFetched } from "../jobs/sync/store";
import { storeNote } from "../jobs/sync/notes";
import { withLock } from "../locks";
import { openStoredRow } from "./records";
import { forUser, inJson, system, type UserScope } from "./scope";
import { userKeysFor } from "./user-keys";

// The guided demo on D1 (src/lib/demo/store.ts and workspace.ts in the Next app). Each signed-in
// person gets a fictional workspace identity of their own; its records go through the real
// normalizers, diffing, encryption and note store. Postgres's advisory locks become UserLock
// queues (audit pattern L); every import step is idempotent, so a retry after a failure only
// fills in what's missing.

const baseUrl = (key: string) => `https://demo.invalid/${key}/FHIR/R4`;
// The fictional case uses Pacific calendar days, independent of a UTC server.
const referenceDate = (value: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
function requireIdentity(userId: string) {
  if (!isDemoIdentity(userId)) throw new Error("demo_forbidden");
}

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

const primaryCreatedAt = async (scope: UserScope) =>
  (await scope.selectFields(healthSource, { createdAt: healthSource.createdAt }, eq(healthSource.fhirBaseUrl, baseUrl("primary"))))[0]?.createdAt;

export function populateDemo(env: Bindings, db: Db, kek: Buffer, userId: string, options: { reset?: boolean; now?: Date } = {}) {
  requireIdentity(userId);
  const scope = forUser(db, userId);
  const now = options.now ?? new Date();
  return withLock(env, `demo:${userId}`, async () => {
    if (options.reset) await scope.delete(healthSource, inJson(healthSource.fhirBaseUrl, DEMO_SOURCES.map((s) => baseUrl(s.key))));
    const anchor = referenceDate((await primaryCreatedAt(scope)) ?? now);
    await importEntries(scope, kek, buildDemoScenario(anchor), now);
    return { anchor };
  });
}

export function importDemoDocument(env: Bindings, db: Db, kek: Buffer, userId: string) {
  requireIdentity(userId);
  const scope = forUser(db, userId);
  return withLock(env, `demo:${userId}`, async () => {
    const createdAt = await primaryCreatedAt(scope);
    if (!createdAt) throw new Error("demo_not_seeded");
    await importEntries(scope, kek, demoDocumentEntries(referenceDate(createdAt)), new Date());
  });
}

export async function demoSnapshot(db: Db, kek: Buffer, userId: string) {
  requireIdentity(userId);
  const scope = forUser(db, userId);
  const sources = await scope.select(healthSource, inJson(healthSource.fhirBaseUrl, DEMO_SOURCES.map((s) => baseUrl(s.key))));
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

type ParentIdentity = { user: { id: string; emailVerified: boolean }; session: { id: string; expiresAt: Date } };

const workspaceSessionId = (parentId: string) => `demo_${createHash("sha256").update(parentId).digest("hex")}`;

async function liveParent(db: Db, identity: ParentIdentity, now: Date) {
  if (!identity.user.emailVerified || identity.session.expiresAt <= now || isDemoIdentity(identity.user.id)) return null;
  const sys = system(db);
  const [[parent], [owner]] = await Promise.all([
    sys.select().from(session).where(and(eq(session.id, identity.session.id), eq(session.userId, identity.user.id))),
    sys.select({ emailVerified: user.emailVerified }).from(user).where(eq(user.id, identity.user.id)),
  ]);
  return parent && !parent.parentSessionId && parent.expiresAt > now && owner?.emailVerified ? parent : null;
}

// Creates no password, sign-in cookie, or public credential for the workspace. The workspace's
// session row names the real login's session as its parent, so signing out (deleting that row)
// removes it too; the batch fails on the foreign key if the login ended since the check.
export async function ensureDemoWorkspace(env: Bindings, db: Db, kek: Buffer, identity: ParentIdentity) {
  const now = new Date();
  const parent = await liveParent(db, identity, now);
  if (!parent) throw new Error("demo_login_required");
  const userId = demoUserId(identity.user.id);
  const sys = system(db);
  await withLock(env, `demo-workspace:${userId}`, () =>
    sys.batch([
      sys.insert(user).values({ id: userId, name: `${DEMO_NAME} (fictional demo)`, email: `${userId.slice(-64)}@demo.invalid`, emailVerified: true, createdAt: now, updatedAt: now }).onConflictDoNothing(),
      forUser(db, userId).insert(profile, { userId, preferredName: "Alex (demo)", consentVersion: CONSENT_VERSION, consentedAt: now, onboardedAt: now }).onConflictDoNothing(),
      sys.insert(session).values({ id: workspaceSessionId(parent.id), userId, parentSessionId: parent.id, token: randomBytes(32).toString("base64url"), expiresAt: parent.expiresAt, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: session.id, set: { expiresAt: parent.expiresAt, updatedAt: now } }),
    ]),
  );
  await populateDemo(env, db, kek, userId);
}

// Resolves only this person's workspace; callers cannot supply an identity.
export async function selectedDemoSession(db: Db, identity: ParentIdentity) {
  const now = new Date();
  const parent = await liveParent(db, identity, now);
  if (!parent) return null;
  const userId = demoUserId(identity.user.id);
  const sys = system(db);
  const [[selected], [demoUser]] = await Promise.all([
    sys.select().from(session).where(and(eq(session.id, workspaceSessionId(parent.id)), eq(session.userId, userId), eq(session.parentSessionId, parent.id))),
    sys.select().from(user).where(eq(user.id, userId)),
  ]);
  if (!selected || !demoUser?.emailVerified) return null;
  if (selected.expiresAt.getTime() !== parent.expiresAt.getTime()) {
    await sys.update(session).set({ expiresAt: parent.expiresAt, updatedAt: now }).where(eq(session.id, selected.id));
  }
  return { user: demoUser, session: { ...selected, expiresAt: parent.expiresAt } };
}

// Guests: anyone without an account can open the demo. Each visitor gets a fictional workspace
// of their own for a day, reached by its own cookie (`<session id>.<token>`). The session row
// stores only the token's SHA-256, so a database read can't be replayed as a cookie, and the
// row can't serve as a Better Auth login (that cookie is signed with the auth secret).
export const GUEST_TTL_MS = 24 * 60 * 60 * 1000;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export async function createGuestDemo(env: Bindings, db: Db, kek: Buffer, now = new Date()) {
  const hex = randomBytes(32).toString("hex");
  const userId = `${DEMO_GUEST_PREFIX}${hex}`;
  const sessionId = `demo_guest_${randomBytes(16).toString("hex")}`;
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + GUEST_TTL_MS);
  const sys = system(db);
  await sys.batch([
    sys.insert(user).values({ id: userId, name: `${DEMO_NAME} (fictional demo)`, email: `${hex}@guest.demo.invalid`, emailVerified: true, createdAt: now, updatedAt: now }),
    forUser(db, userId).insert(profile, { userId, preferredName: "Alex (demo)", consentVersion: CONSENT_VERSION, consentedAt: now, onboardedAt: now }),
    sys.insert(session).values({ id: sessionId, userId, token: sha256(token), expiresAt, createdAt: now, updatedAt: now }),
  ]);
  await populateDemo(env, db, kek, userId, { now });
  return { cookie: `${sessionId}.${token}`, expiresAt };
}

// The guest behind a cookie, or null: unknown, expired, tampered, or not a guest's session.
export async function guestDemoSession(db: Db, cookie: string | undefined, now = new Date()) {
  const match = /^(demo_guest_[a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/.exec(cookie ?? "");
  if (!match) return null;
  const sys = system(db);
  const [found] = await sys.select().from(session).innerJoin(user, eq(user.id, session.userId))
    .where(and(eq(session.id, match[1]), isNull(session.parentSessionId), gt(session.expiresAt, now)));
  if (!found || !isGuestDemoIdentity(found.user.id)) return null;
  const expected = Buffer.from(found.session.token, "hex"), given = createHash("sha256").update(match[2]).digest();
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { user: found.user, session: found.session };
}

// Leaving, or the hourly sweep: deleting the guest deletes its whole fictional chart (cascade).
export async function endGuestDemo(db: Db, cookie: string | undefined): Promise<boolean> {
  const found = await guestDemoSession(db, cookie);
  if (!found) return false;
  await system(db).delete(user).where(eq(user.id, found.user.id));
  return true;
}

export async function deleteExpiredGuests(db: Db, now = new Date()): Promise<number> {
  const sys = system(db);
  const gone = await sys.delete(user).where(and(
    like(user.id, `${DEMO_GUEST_PREFIX}%`),
    notExists(sys.select({ id: session.id }).from(session).where(and(eq(session.userId, user.id), gt(session.expiresAt, now)))),
  )).returning({ id: user.id });
  return gone.length;
}
