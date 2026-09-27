import "server-only";
import { cache } from "react";
import { userKeysFor } from "@/lib/crypto/user-keys";
import { db } from "@/lib/db";
import { asUser } from "@/lib/db/rls";
import { getConnectionForSource } from "@/lib/epic/connections";
import { accessTokenFor, tokenKey } from "@/lib/epic/server";
import { fhirRead } from "@/lib/fhir/client";
import type { RecordItem } from "@/lib/fhir/normalize";
import type { RecordProblem } from "@/lib/records";
import { recordsKey } from "@/lib/records-keys";
import { sourceProblems } from "@/lib/source-display";
import { readNote, type NoteResult } from "@/lib/records-notes";
import { listSources, type SourceSummary } from "@/lib/sources";
import { storedNoteText } from "@/lib/sync/notes";
import { startFirstSyncs } from "@/lib/sync/server";
import { allMatching, allNotes, timelinePage, type TimelineCursor, type TimelineFilters } from "@/lib/timeline";

// Every read here runs as the signed-in person (asUser), so the database itself only shows their rows.
export const loadSourcesFor = cache((userId: string): Promise<SourceSummary[]> => asUser(db, userId, (tx) => listSources(tx, userId)));

export type TimelineView = {
  sources: SourceSummary[];
  items: RecordItem[];
  // Notes for listing inside a visit's detail, whatever page they're on.
  related: RecordItem[];
  next: TimelineCursor | null;
  problems: RecordProblem[];
};

// One page of stored records (synced by the job queue), plus what the person should know
// about their sources. Queues first imports for connected sources that never had one.
export async function loadTimelineFor(userId: string, filters: TimelineFilters, cursor: TimelineCursor | null): Promise<TimelineView> {
  let sources = await loadSourcesFor(userId);
  const queued = await startFirstSyncs(userId, sources);
  return asUser(db, userId, async (tx) => {
    if (queued) sources = await listSources(tx, userId);
    const keys = await userKeysFor(tx, recordsKey(), userId, new Date());
    const page = await timelinePage(tx, keys, userId, sources, filters, cursor);
    // Only visits use `related`, to list their notes; the page's own notes are already in allNotes.
    const related = page.items.some((i) => i.category === "visit") ? await allNotes(tx, keys, userId, sources) : [];
    return { sources, items: page.items, related, next: page.next, problems: sourceProblems(sources) };
  });
}

// A note's text for the signed-in person: the stored copy when there is one (so it works for
// disconnected sources too), else read live through the source's connection.
export async function loadNoteFor(userId: string, sourceId: string, attachmentUrl: string): Promise<NoteResult> {
  const { stored, connection } = await asUser(db, userId, async (tx) => {
    const keys = await userKeysFor(tx, recordsKey(), userId, new Date());
    const stored = await storedNoteText(tx, keys, userId, sourceId, attachmentUrl);
    return { stored, connection: stored === undefined ? await getConnectionForSource(tx, tokenKey(), userId, sourceId) : undefined };
  });
  if (stored !== undefined) return stored === null ? { ok: false, reason: "unsupported" } : { ok: true, text: stored };
  if (!connection) return { ok: false, reason: "not_found" };
  // Outside the transaction: this reads from Epic.
  return readNote(
    { connections: [connection], connectionId: connection.id, attachmentUrl },
    { accessToken: accessTokenFor, read: (input) => fhirRead(input) },
  );
}

// Every stored record the filters select, for the signed-in person to download.
export async function loadExportFor(userId: string, filters: TimelineFilters): Promise<{ sources: SourceSummary[]; items: RecordItem[] }> {
  const sources = await loadSourcesFor(userId);
  const items = await asUser(db, userId, async (tx) => allMatching(tx, await userKeysFor(tx, recordsKey(), userId, new Date()), userId, sources, filters));
  return { sources, items };
}
