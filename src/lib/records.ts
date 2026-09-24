import type { ConnectionSecrets } from "@/lib/epic/connections";
import { EpicError, ReconnectRequiredError } from "@/lib/epic/errors";
import {
  normalizeAllergy,
  normalizeCondition,
  normalizeImmunization,
  normalizeLab,
  normalizeMedication,
  normalizeVisit,
  type RecordCategory,
  type RecordItem,
} from "@/lib/fhir/normalize";
import type { Resource } from "@/lib/fhir/types";

type Query = {
  category: RecordCategory;
  resourceType: string;
  path: (patientId: string) => string;
  normalize: (resource: never, source: string) => RecordItem;
};

const patient = (id: string) => `patient=${encodeURIComponent(id)}`;

// Epic requires a category on Condition and Observation searches.
export const RECORD_QUERIES: Query[] = [
  { category: "condition", resourceType: "Condition", path: (p) => `Condition?${patient(p)}&category=problem-list-item`, normalize: normalizeCondition },
  { category: "medication", resourceType: "MedicationRequest", path: (p) => `MedicationRequest?${patient(p)}`, normalize: normalizeMedication },
  { category: "allergy", resourceType: "AllergyIntolerance", path: (p) => `AllergyIntolerance?${patient(p)}`, normalize: normalizeAllergy },
  { category: "lab", resourceType: "Observation", path: (p) => `Observation?${patient(p)}&category=laboratory`, normalize: normalizeLab },
  { category: "immunization", resourceType: "Immunization", path: (p) => `Immunization?${patient(p)}`, normalize: normalizeImmunization },
  { category: "visit", resourceType: "Encounter", path: (p) => `Encounter?${patient(p)}`, normalize: normalizeVisit },
];

export type RecordProblem = { organizationName: string; kind: "reconnect" | "unavailable" };
export type RecordsResult = { items: RecordItem[]; problems: RecordProblem[] };

type Deps = {
  accessToken: (connection: ConnectionSecrets) => Promise<string>;
  search: (input: { baseUrl: string; path: string; resourceType: string; accessToken: string }) => Promise<Resource[]>;
};

async function fromConnection(connection: ConnectionSecrets, deps: Deps): Promise<RecordsResult> {
  const source = connection.organizationName;
  let accessToken: string;
  try {
    accessToken = await deps.accessToken(connection);
  } catch (error) {
    const kind = error instanceof ReconnectRequiredError ? "reconnect" : "unavailable";
    return { items: [], problems: [{ organizationName: source, kind }] };
  }

  const settled = await Promise.allSettled(
    RECORD_QUERIES.map(async (query) => {
      const resources = await deps.search({
        baseUrl: connection.fhirBaseUrl,
        path: query.path(connection.patientId),
        resourceType: query.resourceType,
        accessToken,
      });
      return resources.map((resource) => query.normalize(resource as never, source));
    }),
  );

  const items: RecordItem[] = [];
  let kind: RecordProblem["kind"] | null = null;
  for (const [i, result] of settled.entries()) {
    if (result.status === "fulfilled") {
      items.push(...result.value);
      continue;
    }
    const status = result.reason instanceof EpicError ? result.reason.status : undefined;
    console.error(`[records] ${RECORD_QUERIES[i].resourceType} failed ${status ?? "network"}`);
    if (result.reason instanceof ReconnectRequiredError) kind = "reconnect";
    else kind ??= "unavailable";
  }
  return { items, problems: kind ? [{ organizationName: source, kind }] : [] };
}

function timeOf(item: RecordItem): number {
  const time = item.date ? Date.parse(item.date.length === 4 ? `${item.date}-01-01` : item.date) : NaN;
  return Number.isNaN(time) ? -Infinity : time;
}

export async function gatherRecords(connections: ConnectionSecrets[], deps: Deps): Promise<RecordsResult> {
  const results = await Promise.all(connections.map((connection) => fromConnection(connection, deps)));
  const items = results.flatMap((r) => r.items).sort((a, b) => timeOf(b) - timeOf(a) || a.title.localeCompare(b.title));
  return { items, problems: results.flatMap((r) => r.problems) };
}

export function countByCategory(items: RecordItem[]): Record<RecordCategory, number> {
  const counts: Record<RecordCategory, number> = { condition: 0, medication: 0, allergy: 0, lab: 0, immunization: 0, visit: 0 };
  for (const item of items) counts[item.category] += 1;
  return counts;
}
