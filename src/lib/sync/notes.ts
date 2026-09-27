import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { hmacFor, sealField, unsealField, type UserKeys } from "@/lib/crypto/user-keys";
import { fhirAttachment, fhirResource, type SyncQueryStats } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { ReconnectRequiredError } from "@/lib/epic/errors";
import { noteAttachment } from "@/lib/fhir/links";
import { noteToText } from "@/lib/fhir/note-text";
import { binaryContent } from "@/lib/records-notes";
import type { SyncDeps, SyncSource } from "./run";
import { openStoredRow } from "./store";

// Note text: each note's readable attachment (a Binary) is fetched once, during sync,
// and stored sealed. Addresses are matched by HMAC, so "already stored?" needs no decryption.

// Notes fetched per sync; the rest follow on later syncs.
export const NOTE_BATCH = 100;
// The original HTML or RTF is kept up to this size; the plain text is always kept.
export const MAX_NOTE_BYTES = 1_000_000;
const CONCURRENCY = 4;
export const NOTES_STATS_KEY = "Binary:note";

const field = (name: string, rowId: string) => ({ table: "fhir_attachment", field: name, rowId });

export async function storeNote(
  db: Db,
  keys: UserKeys,
  input: { userId: string; sourceId: string; resourceId: string; url: string; contentType: string | undefined; raw: string },
  now: Date,
): Promise<void> {
  const id = randomUUID();
  const text = noteToText(input.contentType, input.raw);
  const size = Buffer.byteLength(input.raw, "utf8");
  await db
    .insert(fhirAttachment)
    .values({
      id,
      userId: input.userId,
      sourceId: input.sourceId,
      resourceId: input.resourceId,
      sealedUrl: sealField(keys, input.url, field("url", id)),
      urlHmac: hmacFor(keys, input.url),
      contentType: input.contentType ?? null,
      size,
      sealedText: text === null ? null : sealField(keys, text, field("text", id)),
      sealedBytes: size <= MAX_NOTE_BYTES ? sealField(keys, input.raw, field("bytes", id)) : null,
      fetchedAt: now,
    })
    .onConflictDoNothing();
}

// A stored note's text: a string, null when stored but not text we can show, or
// undefined when it isn't stored yet.
export async function storedNoteText(db: Db, keys: UserKeys, userId: string, sourceId: string, url: string): Promise<string | null | undefined> {
  const [row] = await db
    .select({ id: fhirAttachment.id, sealedText: fhirAttachment.sealedText })
    .from(fhirAttachment)
    .where(and(eq(fhirAttachment.userId, userId), eq(fhirAttachment.sourceId, sourceId), eq(fhirAttachment.urlHmac, hmacFor(keys, url))))
    .limit(1);
  if (!row) return undefined;
  return row.sealedText === null ? null : unsealField(keys, row.sealedText, field("text", row.id));
}

// Fetches and stores the text of this source's notes that aren't stored yet, up to NOTE_BATCH.
// One note failing doesn't stop the rest; a refused token stops the step (the run then ends
// with the source marked for reconnecting).
export async function syncNoteTexts(deps: SyncDeps, source: SyncSource): Promise<SyncQueryStats> {
  const notes = await deps.db
    .select({ id: fhirResource.id, sealedResource: fhirResource.sealedResource, sealedSummary: fhirResource.sealedSummary })
    .from(fhirResource)
    .where(
      and(
        eq(fhirResource.sourceId, source.sourceId),
        eq(fhirResource.category, "note"),
        isNull(fhirResource.supersededAt),
        isNull(fhirResource.removedAt),
      ),
    );
  const stored = new Set(
    (
      await deps.db.select({ urlHmac: fhirAttachment.urlHmac }).from(fhirAttachment).where(eq(fhirAttachment.sourceId, source.sourceId))
    ).map((r) => r.urlHmac),
  );

  const pending: { resourceId: string; url: string }[] = [];
  for (const note of notes) {
    const attachment = noteAttachment(openStoredRow(deps.keys, note).resource);
    if (attachment && !stored.has(hmacFor(deps.keys, attachment.url))) pending.push({ resourceId: note.id, url: attachment.url });
  }
  const batch = pending.slice(0, NOTE_BATCH);

  let inserted = 0;
  let failed = 0;
  if (batch.length) {
    const accessToken = await deps.accessToken();
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, batch.length) }, async () => {
        while (next < batch.length) {
          const note = batch[next++];
          try {
            const content = binaryContent(await deps.read({ baseUrl: source.fhirBaseUrl, path: note.url, accessToken }));
            if (!content) {
              failed++;
              continue;
            }
            await storeNote(deps.db, deps.keys, { userId: source.userId, sourceId: source.sourceId, ...note, ...content }, deps.now());
            inserted++;
          } catch (error) {
            if (error instanceof ReconnectRequiredError) throw error;
            failed++;
          }
        }
      }),
    );
  }
  if (failed) console.error(`[sync] ${NOTES_STATS_KEY} ${failed} failed`);

  return {
    fetched: batch.length,
    inserted,
    superseded: 0,
    unchanged: notes.length - pending.length,
    removed: 0,
    // Notes are best-effort: what's missing is fetched on the next sync, or when opened.
    optional: true,
    ...(failed ? { errorCode: "notes_failed" } : pending.length > batch.length ? { errorCode: "truncated" } : {}),
  };
}
