import { referenceKey } from "@/lib/fhir/references";
import type { Resource } from "@/lib/fhir/types";
import type { FhirBundle } from "./client";

// Metriport hands over one consolidated FHIR bundle per patient rather than a FHIR server to
// search. This answers the sync's searches (the same paths it sends Epic, such as
// `Observation?patient=1&category=laboratory`) from that bundle, so the sync, storage and
// timeline code run unchanged.

type Coded = { coding?: { code?: string }[] }[] | undefined;

function categoryCodes(resource: Resource): string[] {
  return ((resource as { category?: Coded }).category ?? []).flatMap((c) => c.coding ?? []).map((c) => c.code ?? "");
}

// Searches on a `category` the bundle doesn't distinguish: Metriport's conditions aren't split into
// problem list, encounter diagnoses and health concerns, so all of them show as conditions (and
// aren't repeated under the other two). Notes and care plans aren't categorised either.
const WHOLE_TYPE_CATEGORIES = new Set(["problem-list-item", "clinical-note", "38717003"]);
const EMPTY_CATEGORIES = new Set(["encounter-diagnosis", "health-concern"]);

export function searchBundle(bundle: FhirBundle, path: string): Resource[] {
  const [type, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  const category = params.get("category");
  if (params.has("service-category") || (category !== null && EMPTY_CATEGORIES.has(category))) return [];
  const ofType = (bundle.entry ?? []).flatMap((e) => (e.resource?.resourceType === type ? [e.resource] : []));
  if (category === null || WHOLE_TYPE_CATEGORIES.has(category)) return ofType;
  return ofType.filter((r) => categoryCodes(r).includes(category));
}

// One resource by address ('Practitioner/abc'), the way the sync reads referenced resources.
export function readFromBundle(bundle: FhirBundle, address: string): Resource | undefined {
  const ref = referenceKey(address);
  if (!ref) return undefined;
  return (bundle.entry ?? []).find((e) => e.resource?.resourceType === ref.type && e.resource.id === ref.id)?.resource;
}
