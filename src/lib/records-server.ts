import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";
import { getConnectionSecrets } from "@/lib/epic/connections";
import { accessTokenFor, tokenKey } from "@/lib/epic/server";
import { fhirRead, fhirSearchBounded } from "@/lib/fhir/client";
import { gatherRecords, type RecordsResult } from "@/lib/records";
import { readNote, type NoteResult } from "@/lib/records-notes";

// Fetched live for every request and never stored. cache() de-duplicates within one request.
export const loadRecordsFor = cache(async (userId: string): Promise<RecordsResult> => {
  const connections = await getConnectionSecrets(db, tokenKey(), userId);
  return gatherRecords(connections, {
    accessToken: accessTokenFor,
    // Enough pages to reach each search's result cap; beyond it the view says records were left out.
    search: (input) => fhirSearchBounded({ ...input, maxPages: 20 }),
  });
});

// A note's text for the signed-in person, read on request and never stored.
export async function loadNoteFor(userId: string, connectionId: string, attachmentUrl: string): Promise<NoteResult> {
  const connections = await getConnectionSecrets(db, tokenKey(), userId);
  return readNote({ connections, connectionId, attachmentUrl }, { accessToken: accessTokenFor, read: (input) => fhirRead(input) });
}
