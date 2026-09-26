import type { RecordItem } from "./normalize";
import type { DocumentReference, Resource } from "./types";

const READABLE = ["text/html", "application/xhtml+xml", "text/rtf", "application/rtf", "text/plain"];

// The attachment of a note we can show as text, preferring HTML, then RTF, then plain text.
export function noteAttachment(resource: Resource): { url: string; contentType: string } | null {
  const attachments = ((resource as DocumentReference).content ?? []).map((c) => c.attachment).filter((a) => a?.url && a.contentType);
  const rank = (type: string) => READABLE.indexOf(type.split(";")[0].trim().toLowerCase());
  const best = attachments
    .filter((a) => rank(a!.contentType!) >= 0)
    .sort((a, b) => rank(a!.contentType!) - rank(b!.contentType!))[0];
  return best ? { url: best.url!, contentType: best.contentType! } : null;
}

// Notes written at a visit: same connection, and context.encounter points at the visit.
export function notesForVisit(visit: RecordItem, items: RecordItem[]): RecordItem[] {
  const id = visit.resource.id;
  if (!id) return [];
  return items.filter(
    (item) =>
      item.category === "note" &&
      item.connectionId === visit.connectionId &&
      item.source === visit.source &&
      ((item.resource as DocumentReference).context?.encounter ?? []).some((ref) => ref.reference?.split("/").slice(-2).join("/") === `Encounter/${id}`),
  );
}
