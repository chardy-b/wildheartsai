export const MAX_NOTE_CHARS = 50_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol)>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  );
}

function rtfToText(rtf: string): string {
  return (
    rtf
      // Destination groups ({\*\generator …}, font and color tables) hold no note text.
      .replace(/\{\\\*[^{}]*\}/g, "")
      .replace(/\{\\(fonttbl|colortbl|stylesheet|info)(?:[^{}]|\{[^{}]*\})*\}/g, "")
      .replace(/\\par[d]?\b ?/g, "\n")
      .replace(/\\line\b ?/g, "\n")
      .replace(/\\tab\b ?/g, "\t")
      .replace(/\\'([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\u(-?\d+)\??/g, (_, n: string) => String.fromCharCode((Number(n) + 65536) % 65536))
      .replace(/\\[a-z]+-?\d* ?/gi, "")
      .replace(/\\([{}\\])/g, "$1")
      .replace(/[{}]/g, "")
  );
}

function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A note's text as plain text, never markup, so nothing from the health system
// is rendered as HTML. Returns null for formats we can't show (PDF, images).
export function noteToText(contentType: string | undefined, body: string): string | null {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  let text: string;
  if (type === "text/html" || type === "application/xhtml+xml") text = htmlToText(body);
  else if (type === "text/rtf" || type === "application/rtf") text = rtfToText(body);
  else if (type === "text/plain") text = body;
  else return null;
  const clean = tidy(text);
  return clean.length > MAX_NOTE_CHARS ? `${clean.slice(0, MAX_NOTE_CHARS).trimEnd()}\n\n[Note shortened]` : clean;
}
