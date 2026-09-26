import "server-only";
import { cache } from "react";
import { userKeysFor } from "@/lib/crypto/user-keys";
import { db } from "@/lib/db";
import { getConnectionSecrets } from "@/lib/epic/connections";
import { accessTokenFor, tokenKey } from "@/lib/epic/server";
import { fhirRead } from "@/lib/fhir/client";
import type { RecordItem } from "@/lib/fhir/normalize";
import type { RecordProblem } from "@/lib/records";
import { recordsKey } from "@/lib/records-keys";
import { sourceProblems } from "@/lib/source-display";
import { readNote, type NoteResult } from "@/lib/records-notes";
import { listSources, type SourceSummary } from "@/lib/sources";
import { startFirstSyncs } from "@/lib/sync/server";
import { allNotes, timelinePage, type TimelineCursor, type TimelineFilters } from "@/lib/timeline";

export const loadSourcesFor = cache((userId: string): Promise<SourceSummary[]> => listSources(db, userId));

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
  if (await startFirstSyncs(userId, sources)) sources = await listSources(db, userId);
  const keys = await userKeysFor(db, recordsKey(), userId, new Date());
  const page = await timelinePage(db, keys, userId, sources, filters, cursor);
  // Only visits use `related`, to list their notes; the page's own notes are already in allNotes.
  const related = page.items.some((i) => i.category === "visit") ? await allNotes(db, keys, userId, sources) : [];
  return { sources, items: page.items, related, next: page.next, problems: sourceProblems(sources) };
}

// A note's text for the signed-in person, read on request through their live connection.
export async function loadNoteFor(userId: string, connectionId: string, attachmentUrl: string): Promise<NoteResult> {
  const connections = await getConnectionSecrets(db, tokenKey(), userId);
  return readNote({ connections, connectionId, attachmentUrl }, { accessToken: accessTokenFor, read: (input) => fhirRead(input) });
}
