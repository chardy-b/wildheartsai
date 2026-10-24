import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { asUser } from "@/lib/db/rls";
import type { Db } from "@/lib/db/types";
import { fhirResource, healthSource, syncRun } from "@/lib/db/schema";
import { userKeysFor } from "@/lib/crypto/user-keys";
import { applyDiff, currentRows, openStoredRow, prepareFetched } from "@/lib/sync/store";
import { diffResources } from "@/lib/sync/diff";
import { SYNC_QUERIES } from "@/lib/sync/plan";
import { storeNote } from "@/lib/sync/notes";
import { describeResource } from "@/lib/fhir/describe";
import { buildDemoScenario, demoDocumentEntries, DEMO_SOURCES, type DemoEntry } from "./scenario";

import { isDemoIdentity } from "./identity";

const baseUrl = (key: string) => `https://demo.invalid/${key}/FHIR/R4`;
// The fictional case uses Pacific calendar days, independent of a UTC server.
const referenceDate = (value: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
function requireIdentity(userId: string) { if (!isDemoIdentity(userId)) throw new Error("demo_forbidden"); }

async function lock(tx: Db, userId: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`demo:${userId}`}))`); }

// Uses the production normalizers, diffing, encryption, note store and RLS. There
// are deliberately no Epic connections or OAuth placeholders to refresh later.
async function importEntries(tx: Db, kek: Buffer, userId: string, entries: DemoEntry[], now: Date) {
  const keys = await userKeysFor(tx, kek, userId, now);
  const sources = await tx.select().from(healthSource).where(eq(healthSource.userId, userId));
  for (const source of DEMO_SOURCES) {
    const selected = entries.filter(e => e.source === source.key);
    if (!selected.length) continue;
    let storedSource = sources.find(s => s.fhirBaseUrl === baseUrl(source.key));
    if (!storedSource) {
      [storedSource] = await tx.insert(healthSource).values({ userId: userId, vendor: "epic", fhirBaseUrl: baseUrl(source.key), organizationName: `${source.name} · fictional demo`, status: "disconnected", createdAt: now, updatedAt: now }).returning();
    }
    let inserted = 0, unchanged = 0;
    for (const entry of selected) {
      const query = SYNC_QUERIES.find(q => q.resourceType === entry.resource.resourceType && q.category === entry.category);
      if (!query) throw new Error("unsupported_demo_type");
      const existing = await currentRows(tx, storedSource.id, query, [entry.resource.id!], false);
      const diff = diffResources(prepareFetched(keys, [entry.resource]), existing, {});
      const counts = await applyDiff(tx, keys, { userId: userId, sourceId: storedSource.id, organizationName: storedSource.organizationName, query }, diff, now);
      inserted += counts.inserted; unchanged += counts.unchanged;
      if (entry.noteText) {
        const [record] = await tx.select({ id: fhirResource.id }).from(fhirResource).where(and(eq(fhirResource.userId, userId), eq(fhirResource.sourceId, storedSource.id), eq(fhirResource.fhirId, entry.resource.id!), isNull(fhirResource.supersededAt)));
        await storeNote(tx, keys, { userId: userId, sourceId: storedSource.id, resourceId: record.id, url: `Binary/${entry.resource.id}`, contentType: "text/plain", raw: entry.noteText }, now);
      }
    }
    await tx.update(healthSource).set({ lastSyncedAt: now, lastSyncStatus: "ok", updatedAt: now }).where(and(eq(healthSource.id, storedSource.id), eq(healthSource.userId, userId)));
    // Bounded metadata history: repeat presentations do not grow an unbounded log.
    await tx.delete(syncRun).where(and(eq(syncRun.userId, userId), eq(syncRun.sourceId, storedSource.id)));
    await tx.insert(syncRun).values({ userId: userId, sourceId: storedSource.id, trigger: "manual", status: "ok", queuedAt: now, startedAt: now, finishedAt: now, stats: { "demo:fixture": { fetched: selected.length, inserted, unchanged, superseded: 0, removed: 0 } } });
  }
}

export function populateDemo(db: Db, kek: Buffer, userId: string, options: { reset?: boolean; now?: Date } = {}) {
  requireIdentity(userId);
  const now = options.now ?? new Date();
  return asUser(db, userId, async tx => {
    await lock(tx, userId);
    const urls = DEMO_SOURCES.map(s => baseUrl(s.key));
    if (options.reset) await tx.delete(healthSource).where(and(eq(healthSource.userId, userId), inArray(healthSource.fhirBaseUrl, urls)));
    const [source] = await tx.select({ createdAt: healthSource.createdAt }).from(healthSource).where(and(eq(healthSource.userId, userId), eq(healthSource.fhirBaseUrl, baseUrl("primary"))));
    const anchor = referenceDate(source?.createdAt ?? now);
    await importEntries(tx, kek, userId, buildDemoScenario(anchor), now);
    return { anchor };
  });
}

export function importDemoDocument(db: Db, kek: Buffer, userId: string) {
  requireIdentity(userId);
  return asUser(db, userId, async tx => {
    await lock(tx, userId);
    const [source] = await tx.select({ createdAt: healthSource.createdAt }).from(healthSource).where(and(eq(healthSource.userId, userId), eq(healthSource.fhirBaseUrl, baseUrl("primary"))));
    if (!source) throw new Error("demo_not_seeded");
    await importEntries(tx, kek, userId, demoDocumentEntries(referenceDate(source.createdAt)), new Date());
  });
}

export function demoSnapshot(db: Db, kek: Buffer, userId: string) {
  requireIdentity(userId);
  return asUser(db, userId, async tx => {
    const sources = await tx.select().from(healthSource).where(and(eq(healthSource.userId, userId), inArray(healthSource.fhirBaseUrl, DEMO_SOURCES.map(s => baseUrl(s.key)))));
    const primary = sources.find(s => s.fhirBaseUrl === baseUrl("primary"));
    if (!primary) return null;
    const keys = await userKeysFor(tx, kek, userId, new Date());
    const rows = await tx.select().from(fhirResource).where(and(eq(fhirResource.userId, userId), inArray(fhirResource.sourceId, sources.map(s => s.id)), isNull(fhirResource.supersededAt), isNull(fhirResource.removedAt))).limit(200);
    return {
      anchor: referenceDate(primary.createdAt),
      sources: sources.map(source => ({ id: source.id, key: DEMO_SOURCES.find(s => baseUrl(s.key) === source.fhirBaseUrl)!.key, name: source.organizationName, syncedAt: source.lastSyncedAt?.toISOString() ?? null, count: rows.filter(r => r.sourceId === source.id).length })),
      records: rows.map(row => { const opened = openStoredRow(keys, row); return { id: row.id, sourceId: row.sourceId, fhirId: row.fhirId, category: row.category, resourceType: row.resourceType, title: opened.summary.title, detail: opened.summary.detail, date: opened.summary.date, resource: opened.resource, sections: describeResource(opened.resource) }; }),
    };
  });
}
export type DemoSnapshot = NonNullable<Awaited<ReturnType<typeof demoSnapshot>>>;
