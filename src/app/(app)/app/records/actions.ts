"use server";

import { loadNoteFor } from "@/lib/records-server";
import type { NoteResult } from "@/lib/records-notes";
import { requireSession } from "@/lib/session";

// Called by "Show note". The connection must belong to the signed-in person and
// the address must be inside that connection's FHIR base (checked in fhirRead).
export async function showNoteAction(connectionId: string, attachmentUrl: string): Promise<NoteResult> {
  const session = await requireSession();
  if (typeof connectionId !== "string" || typeof attachmentUrl !== "string" || attachmentUrl.length > 2048) {
    return { ok: false, reason: "not_found" };
  }
  return loadNoteFor(session.user.id, connectionId, attachmentUrl);
}
