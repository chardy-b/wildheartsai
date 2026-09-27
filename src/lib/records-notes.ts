import type { ConnectionSecrets } from "@/lib/epic/connections";
import { EpicError, ReconnectRequiredError } from "@/lib/epic/errors";
import { noteToText } from "@/lib/fhir/note-text";
import type { Resource } from "@/lib/fhir/types";

export type NoteResult = { ok: true; text: string } | { ok: false; reason: "not_found" | "unsupported" | "reconnect" | "unavailable" };

type Binary = Resource & { resourceType: "Binary"; contentType?: string; data?: string };

// A Binary's content as sent (HTML, RTF or plain text), or null if it isn't a Binary with data.
export function binaryContent(resource: unknown): { contentType: string | undefined; raw: string } | null {
  const binary = resource as Binary;
  if (binary?.resourceType !== "Binary" || typeof binary.data !== "string") return null;
  return { contentType: binary.contentType, raw: Buffer.from(binary.data, "base64").toString("utf8") };
}

type Deps = {
  accessToken: (connection: ConnectionSecrets) => Promise<string>;
  read: (input: { baseUrl: string; path: string; accessToken: string }) => Promise<unknown>;
};

// A note's text, read live through one of the person's own connections and
// returned as plain text. Nothing is stored or logged beyond an error code.
export async function readNote(
  input: { connections: ConnectionSecrets[]; connectionId: string; attachmentUrl: string },
  deps: Deps,
): Promise<NoteResult> {
  const connection = input.connections.find((c) => c.id === input.connectionId);
  if (!connection) return { ok: false, reason: "not_found" };

  try {
    const accessToken = await deps.accessToken(connection);
    const content = binaryContent(await deps.read({ baseUrl: connection.fhirBaseUrl, path: input.attachmentUrl, accessToken }));
    if (!content) return { ok: false, reason: "unavailable" };
    const text = noteToText(content.contentType, content.raw);
    return text === null ? { ok: false, reason: "unsupported" } : { ok: true, text };
  } catch (error) {
    if (error instanceof ReconnectRequiredError) return { ok: false, reason: "reconnect" };
    const detail = error instanceof EpicError ? (error.status ?? error.code ?? "fhir") : "network";
    console.error(`[records] note failed ${detail}`);
    return { ok: false, reason: "unavailable" };
  }
}
