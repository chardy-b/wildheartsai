import "server-only";
import { cache } from "react";
import { userKeysFor } from "@/lib/crypto/user-keys";
import { db } from "@/lib/db";
import { getConnectionSecrets } from "@/lib/epic/connections";
import { accessTokenFor, tokenKey } from "@/lib/epic/server";
import { fhirRead } from "@/lib/fhir/client";
import type { RecordsResult } from "@/lib/records";
import { recordsKey } from "@/lib/records-keys";
import { loadStoredRecords } from "@/lib/records-store";
import { readNote, type NoteResult } from "@/lib/records-notes";
import { listSources, type SourceSummary } from "@/lib/sources";
import { startFirstSyncs } from "@/lib/sync/server";

export const loadSourcesFor = cache((userId: string): Promise<SourceSummary[]> => listSources(db, userId));

// Stored records from every source, read from our database (synced by the job queue).
// cache() de-duplicates within one request.
export const loadRecordsFor = cache(async (userId: string): Promise<RecordsResult> => {
  let sources = await loadSourcesFor(userId);
  if (await startFirstSyncs(userId, sources)) sources = await listSources(db, userId);
  const keys = await userKeysFor(db, recordsKey(), userId, new Date());
  return loadStoredRecords(db, keys, userId, sources);
});

// A note's text for the signed-in person, read on request through their live connection.
export async function loadNoteFor(userId: string, connectionId: string, attachmentUrl: string): Promise<NoteResult> {
  const connections = await getConnectionSecrets(db, tokenKey(), userId);
  return readNote({ connections, connectionId, attachmentUrl }, { accessToken: accessTokenFor, read: (input) => fhirRead(input) });
}
