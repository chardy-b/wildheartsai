import type { StoredSummary } from "./normalize";
import type { Resource } from "./types";

// Resources that records point to rather than contain: stored once per source during sync
// (src/lib/sync/references.ts), then used to fill in missing names and to show linked details.

export const REFERENCED_TYPES = ["Medication", "Practitioner", "PractitionerRole", "Organization", "Location"] as const;
export type ReferencedType = (typeof REFERENCED_TYPES)[number];

const REFERENCE = new RegExp(`(?:^|/)(${REFERENCED_TYPES.join("|")})/([A-Za-z0-9\\-.]{1,64})$`);

// "Practitioner/abc" from a relative or absolute reference; null for anything else (contained "#x", other types).
export function referenceKey(reference: string | undefined): { type: ReferencedType; id: string; key: string } | null {
  if (!reference || reference.startsWith("#")) return null;
  const match = REFERENCE.exec(reference.split(/[?#]/)[0]);
  if (!match) return null;
  const [, type, id] = match;
  return { type: type as ReferencedType, id, key: `${type}/${id}` };
}

type Json = unknown;

function walk(value: Json, visit: (node: Record<string, Json>) => void): void {
  if (Array.isArray(value)) value.forEach((v) => walk(v, visit));
  else if (value !== null && typeof value === "object") {
    visit(value as Record<string, Json>);
    Object.values(value).forEach((v) => walk(v, visit));
  }
}

// Every referenced resource a record points to, once each, in order of appearance.
export function collectReferences(resource: Resource): string[] {
  const keys: string[] = [];
  walk(resource, (node) => {
    const ref = typeof node.reference === "string" ? referenceKey(node.reference) : null;
    if (ref && !keys.includes(ref.key)) keys.push(ref.key);
  });
  return keys;
}

function humanName(name: Json): string | null {
  const n = (Array.isArray(name) ? name[0] : name) as { text?: string; given?: string[]; family?: string; prefix?: string[] } | undefined;
  if (!n) return null;
  return n.text?.trim() || [...(n.prefix ?? []), ...(n.given ?? []), n.family].filter(Boolean).join(" ") || null;
}

function conceptText(concept: Json): string | null {
  const c = (Array.isArray(concept) ? concept[0] : concept) as { text?: string; coding?: { display?: string }[] } | undefined;
  return c?.text?.trim() || c?.coding?.find((x) => x.display)?.display?.trim() || null;
}

// The name a referenced resource goes by, as a record would show it.
export function referencedName(resource: Resource): string | null {
  const r = resource as Resource & Record<string, Json>;
  switch (resource.resourceType) {
    case "Practitioner":
      return humanName(r.name);
    case "PractitionerRole": {
      const who = (r.practitioner as { display?: string } | undefined)?.display ?? null;
      const role = conceptText(r.specialty) ?? conceptText(r.code);
      return [who, role].filter(Boolean).join(", ") || null;
    }
    case "Organization":
    case "Location":
      return typeof r.name === "string" && r.name.trim() ? r.name.trim() : null;
    case "Medication":
      return conceptText(r.code);
    default:
      return null;
  }
}

// A copy of the record with names filled in where a reference has none. References that
// already carry a name keep it: that's what the health system recorded.
export function withNames<T extends Resource>(resource: T, names: Map<string, string>): T {
  let changed = false;
  const copy = JSON.parse(JSON.stringify(resource)) as T;
  walk(copy, (node) => {
    if (typeof node.reference !== "string" || (typeof node.display === "string" && node.display.trim())) return;
    const ref = referenceKey(node.reference);
    const name = ref ? names.get(ref.key) : undefined;
    if (name) {
      node.display = name;
      changed = true;
    }
  });
  return changed ? copy : resource;
}

// Stored without a category: kept for names and linked details, never listed as a record.
export function normalizeReferenced(resource: Resource, source: string): StoredSummary {
  return {
    key: `${source}|${resource.resourceType}/${resource.id ?? "unknown"}`,
    source,
    category: null,
    title: referencedName(resource) ?? resource.resourceType,
    date: null,
    detail: null,
    status: null,
  };
}
