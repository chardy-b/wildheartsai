"use server";

import { loadNoteFor } from "@/lib/records-server";
import type { NoteResult } from "@/lib/records-notes";
import { requireSession } from "@/lib/session";

// Called by "Show note". Stored text is looked up by the signed-in person's own source;
// a live read also needs that source's connection, and the address must be inside its
// FHIR base (checked in fhirRead).
export async function showNoteAction(sourceId: string, attachmentUrl: string): Promise<NoteResult> {
  const session = await requireSession();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof sourceId !== "string" || !uuid.test(sourceId) || typeof attachmentUrl !== "string" || attachmentUrl.length > 2048) {
    return { ok: false, reason: "not_found" };
  }
  return loadNoteFor(session.user.id, sourceId, attachmentUrl);
}
