import { REFERENCED_TYPES } from "@/lib/fhir/references";
import { SYNC_QUERIES } from "@/lib/sync/plan";

// Metriport's records carry no per-resource permissions, so the connection "grants" every type the
// sync reads. Not Binary: Metriport serves documents as files, not FHIR Binary resources, so note
// text isn't imported.
export const METRIPORT_SCOPE = [...new Set([...SYNC_QUERIES.map((q) => q.resourceType), ...REFERENCED_TYPES])].map((type) => `patient/${type}.rs`).join(" ");
