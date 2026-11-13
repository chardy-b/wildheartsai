// Epic's Brands bundle is ~95 MB: more than a Worker's 128 MB of memory once parsed whole. This
// reads it as a stream and yields the elements of its top-level `entry` array one at a time, each
// parsed on its own, so only one entry's text is held at once. It also checks the document is a
// FHIR Bundle. Other top-level values are skipped without being kept.

export class NotABundleError extends Error {}

export async function* bundleEntries(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let depth = 0;
  let inString = false;
  let escaped = false;
  // Top-level strings (keys, and values such as resourceType) are short; they're collected.
  let topString: string | null = null;
  let lastKey: string | null = null;
  let key: string | null = null;
  let expectValue = false;
  let resourceType: string | null = null;
  let inEntries = false;
  // The current entry's text, across chunks.
  let element: string[] | null = null;

  for (;;) {
    const { done, value: text } = await reader.read();
    if (done) break;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') {
          inString = false;
          if (topString !== null) {
            if (expectValue) {
              if (key === "resourceType") resourceType = topString;
              expectValue = false;
            } else lastKey = topString;
            topString = null;
          }
          continue;
        }
        if (topString !== null) topString += c;
        continue;
      }
      if (c === '"') {
        inString = true;
        topString = depth === 1 ? "" : null;
      } else if (c === "{" || c === "[") {
        if (inEntries && depth === 2 && c === "{") {
          element = [];
          start = i;
        }
        if (depth === 1 && c === "[" && expectValue && key === "entry") inEntries = true;
        if (depth === 1) expectValue = false;
        depth++;
      } else if (c === "}" || c === "]") {
        depth--;
        if (element && depth === 2 && c === "}") {
          element.push(text.slice(start, i + 1));
          const entry: unknown = JSON.parse(element.join(""));
          element = null;
          yield entry;
        }
        if (inEntries && depth === 1) inEntries = false;
      } else if (depth === 1 && c === ":") {
        key = lastKey;
        expectValue = true;
      } else if (depth === 1 && c === ",") {
        key = null;
        expectValue = false;
      }
    }
    if (element) element.push(text.slice(start));
  }
  if (resourceType !== "Bundle" || depth !== 0) throw new NotABundleError("Epic brands list isn't a FHIR Bundle");
}

type Entry = { fullUrl?: unknown; resource?: Record<string, unknown> };

// Only what buildDirectory (src/lib/epic/brands.ts) reads: names, status, an endpoint's address,
// a facility's first city and state, and the first endpoint and partOf references.
export function trimBrandEntry(value: unknown): { fullUrl: string; resource: Record<string, unknown> } | null {
  const { fullUrl, resource } = (value ?? {}) as Entry;
  if (typeof fullUrl !== "string" || !resource || typeof resource !== "object") return null;
  const trimmed: Record<string, unknown> = { resourceType: resource.resourceType };
  if (resource.name !== undefined) trimmed.name = resource.name;
  if (resource.status !== undefined) trimmed.status = resource.status;
  if (resource.resourceType === "Endpoint") {
    if (typeof resource.address === "string") trimmed.address = resource.address;
  } else if (Array.isArray(resource.address)) {
    trimmed.address = resource.address.slice(0, 1).map((a: { city?: unknown; state?: unknown } | null) => ({ city: a?.city, state: a?.state }));
  }
  const partOf = resource.partOf as { reference?: unknown } | undefined;
  if (partOf) trimmed.partOf = { reference: partOf.reference };
  if (Array.isArray(resource.endpoint)) trimmed.endpoint = resource.endpoint.slice(0, 1).map((e: { reference?: unknown } | null) => ({ reference: e?.reference }));
  return { fullUrl, resource: trimmed };
}
