import { and, eq, isNull } from "drizzle-orm";
import { ReconnectRequiredError } from "@/lib/epic/errors";
import { noteAttachment } from "@/lib/fhir/links";
import { noteToText } from "@/lib/fhir/note-text";
import { binaryContent } from "@/lib/records-notes";
import { hmacFor, sealField, type UserKeys } from "../../crypto/fields";
import { openStoredRow } from "../../data/records";
import type { UserScope } from "../../data/scope";
import { fhirAttachment, fhirResource, type SyncQueryStats } from "../../db/schema";
import type { SyncDeps, SyncSource } from "./run";

// Note text (src/lib/sync/notes.ts in the Next app): each note's readable attachment (a Binary)
// is fetched once, during sync, and stored sealed. Addresses are matched by HMAC.

// Notes fetched per sync; the rest follow on later syncs.
export const NOTE_BATCH = 100;
// The original HTML or RTF is kept up to this size; the plain text is always kept.
export const MAX_NOTE_BYTES = 1_000_000;
const CONCURRENCY = 4;
export const NOTES_STATS_KEY = "Binary:note";

const field = (name: string, rowId: string) => ({ table: "fhir_attachment", field: name, rowId });

export async function storeNote(
  scope: UserScope,
  keys: UserKeys,
  input: { sourceId: string; resourceId: string; url: string; contentType: string | undefined; raw: string },
  now: Date,
): Promise<void> {
  const id = crypto.randomUUID();
  const text = noteToText(input.contentType, input.raw);
  const size = Buffer.byteLength(input.raw, "utf8");
  await scope
    .insert(fhirAttachment, {
      id,
      userId: scope.userId,
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

// Fetches and stores the text of this source's notes that aren't stored yet, up to NOTE_BATCH.
// One note failing doesn't stop the rest; a refused token stops the step.
export async function syncNoteTexts(deps: SyncDeps, source: SyncSource): Promise<SyncQueryStats> {
  const notes = await deps.scope.selectFields(
    fhirResource,
    { id: fhirResource.id, sealedResource: fhirResource.sealedResource, sealedSummary: fhirResource.sealedSummary },
    and(eq(fhirResource.sourceId, source.sourceId), eq(fhirResource.category, "note"), isNull(fhirResource.supersededAt), isNull(fhirResource.removedAt)),
  );
  const stored = new Set((await deps.scope.selectFields(fhirAttachment, { urlHmac: fhirAttachment.urlHmac }, eq(fhirAttachment.sourceId, source.sourceId))).map((r) => r.urlHmac));

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
            await storeNote(deps.scope, deps.keys, { sourceId: source.sourceId, ...note, ...content }, deps.now());
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
