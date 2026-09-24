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

const MAX_CONNECTIONS = 5;
const MAX_CONCURRENT_CONNECTIONS = 2;
const MAX_CONCURRENT_SEARCHES = 3;

async function allSettledWithLimit<T, R>(
  values: T[],
  limit: number,
  work: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        try {
          results[index] = { status: "fulfilled", value: await work(values[index]) };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    }),
  );
  return results;
}

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

  const settled = await allSettledWithLimit(RECORD_QUERIES, MAX_CONCURRENT_SEARCHES, async (query) => {
      const resources = await deps.search({
        baseUrl: connection.fhirBaseUrl,
        path: query.path(connection.patientId),
        resourceType: query.resourceType,
        accessToken,
      });
      return resources.map((resource) => query.normalize(resource as never, source));
    });

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
  const selected = connections.slice(0, MAX_CONNECTIONS);
  const settled = await allSettledWithLimit(selected, MAX_CONCURRENT_CONNECTIONS, (connection) => fromConnection(connection, deps));
  const results = settled.map((result, index): RecordsResult =>
    result.status === "fulfilled"
      ? result.value
      : { items: [], problems: [{ organizationName: selected[index].organizationName, kind: "unavailable" }] },
  );
  const items = results.flatMap((r) => r.items).sort((a, b) => timeOf(b) - timeOf(a) || a.title.localeCompare(b.title));
  const skipped = connections.slice(MAX_CONNECTIONS).map(({ organizationName }) => ({ organizationName, kind: "unavailable" as const }));
  return { items, problems: [...results.flatMap((r) => r.problems), ...skipped] };
}

export function countByCategory(items: RecordItem[]): Record<RecordCategory, number> {
  const counts: Record<RecordCategory, number> = { condition: 0, medication: 0, allergy: 0, lab: 0, immunization: 0, visit: 0 };
  for (const item of items) counts[item.category] += 1;
  return counts;
}
