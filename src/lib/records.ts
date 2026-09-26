import type { ConnectionSecrets } from "@/lib/epic/connections";
import { EpicError, ReconnectRequiredError } from "@/lib/epic/errors";
import { CATEGORIES } from "@/lib/fhir/categories";
import {
  normalizeAllergy,
  normalizeCarePlan,
  normalizeCareTeam,
  normalizeCondition,
  normalizeCoverage,
  normalizeDevice,
  normalizeFill,
  normalizeGoal,
  normalizeImmunization,
  normalizeLab,
  normalizeMedication,
  normalizeNote,
  normalizeOrder,
  normalizeProcedure,
  normalizeReport,
  normalizeSocial,
  normalizeVisit,
  normalizeVital,
  type RecordCategory,
  type RecordItem,
  type RecordSummary,
} from "@/lib/fhir/normalize";
import type { Resource } from "@/lib/fhir/types";

type Query = {
  category: RecordCategory;
  resourceType: string;
  path: (patientId: string) => string;
  normalize: (resource: never, source: string) => RecordSummary;
  // Higher cap for types a long history fills quickly. Beyond it, the rest are
  // skipped and the person is told (a "partial" problem), rather than failing.
  maxResources?: number;
};

const HIGH_VOLUME = 500;

const patient = (id: string) => `patient=${encodeURIComponent(id)}`;

// Every resource type the dashboard displays, and nothing else (issue #11).
// Epic requires a category on Condition, Observation, DocumentReference and CarePlan searches.
export const RECORD_QUERIES: Query[] = [
  { category: "condition", resourceType: "Condition", path: (p) => `Condition?${patient(p)}&category=problem-list-item`, normalize: normalizeCondition },
  { category: "medication", resourceType: "MedicationRequest", path: (p) => `MedicationRequest?${patient(p)}`, normalize: normalizeMedication },
  { category: "allergy", resourceType: "AllergyIntolerance", path: (p) => `AllergyIntolerance?${patient(p)}`, normalize: normalizeAllergy },
  { category: "lab", resourceType: "Observation", path: (p) => `Observation?${patient(p)}&category=laboratory`, normalize: normalizeLab, maxResources: HIGH_VOLUME },
  { category: "immunization", resourceType: "Immunization", path: (p) => `Immunization?${patient(p)}`, normalize: normalizeImmunization },
  { category: "visit", resourceType: "Encounter", path: (p) => `Encounter?${patient(p)}`, normalize: normalizeVisit },
  { category: "report", resourceType: "DiagnosticReport", path: (p) => `DiagnosticReport?${patient(p)}`, normalize: normalizeReport },
  { category: "note", resourceType: "DocumentReference", path: (p) => `DocumentReference?${patient(p)}&category=clinical-note`, normalize: normalizeNote },
  { category: "procedure", resourceType: "Procedure", path: (p) => `Procedure?${patient(p)}`, normalize: normalizeProcedure },
  { category: "vital", resourceType: "Observation", path: (p) => `Observation?${patient(p)}&category=vital-signs`, normalize: normalizeVital, maxResources: HIGH_VOLUME },
  { category: "social", resourceType: "Observation", path: (p) => `Observation?${patient(p)}&category=social-history`, normalize: normalizeSocial, maxResources: HIGH_VOLUME },
  { category: "careTeam", resourceType: "CareTeam", path: (p) => `CareTeam?${patient(p)}`, normalize: normalizeCareTeam },
  // 38717003: SNOMED "Longitudinal care plan", the category Epic supports for patients.
  { category: "carePlan", resourceType: "CarePlan", path: (p) => `CarePlan?${patient(p)}&category=38717003`, normalize: normalizeCarePlan },
  { category: "goal", resourceType: "Goal", path: (p) => `Goal?${patient(p)}`, normalize: normalizeGoal },
  { category: "order", resourceType: "ServiceRequest", path: (p) => `ServiceRequest?${patient(p)}`, normalize: normalizeOrder },
  { category: "fill", resourceType: "MedicationDispense", path: (p) => `MedicationDispense?${patient(p)}`, normalize: normalizeFill },
  { category: "device", resourceType: "Device", path: (p) => `Device?${patient(p)}`, normalize: normalizeDevice },
  { category: "coverage", resourceType: "Coverage", path: (p) => `Coverage?${patient(p)}`, normalize: normalizeCoverage },
];

export type RecordProblem =
  | { organizationName: string; kind: "reconnect" | "unavailable" }
  | { organizationName: string; kind: "partial"; categories: RecordCategory[] };
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
  search: (input: {
    baseUrl: string;
    path: string;
    resourceType: string;
    accessToken: string;
    maxResources?: number;
  }) => Promise<{ resources: Resource[]; truncated: boolean }>;
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
      const { resources, truncated } = await deps.search({
        baseUrl: connection.fhirBaseUrl,
        path: query.path(connection.patientId),
        resourceType: query.resourceType,
        accessToken,
        ...(query.maxResources ? { maxResources: query.maxResources } : {}),
      });
      const items = resources.map((resource): RecordItem => ({
        ...query.normalize(resource as never, source),
        resource,
        connectionId: connection.id,
      }));
      return { items, truncated };
    });

  const items: RecordItem[] = [];
  const partial: RecordCategory[] = [];
  let kind: "reconnect" | "unavailable" | null = null;
  for (const [i, result] of settled.entries()) {
    if (result.status === "fulfilled") {
      items.push(...result.value.items);
      if (result.value.truncated) {
        partial.push(RECORD_QUERIES[i].category);
        console.error(`[records] ${RECORD_QUERIES[i].resourceType} (${RECORD_QUERIES[i].category}) truncated`);
      }
      continue;
    }
    // HTTP status, else the client's own error code (resource_limit, page_limit, ...), else a network failure.
    const reason = result.reason instanceof EpicError ? (result.reason.status ?? result.reason.code) : undefined;
    const { resourceType, category } = RECORD_QUERIES[i];
    console.error(`[records] ${resourceType} (${category}) failed ${reason ?? "network"}`);
    if (result.reason instanceof ReconnectRequiredError) kind = "reconnect";
    else kind ??= "unavailable";
  }
  const problems: RecordProblem[] = [];
  if (kind) problems.push({ organizationName: source, kind });
  if (partial.length) problems.push({ organizationName: source, kind: "partial", categories: partial });
  return { items, problems };
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
  const counts = Object.fromEntries(CATEGORIES.map(({ category }) => [category, 0])) as Record<RecordCategory, number>;
  for (const item of items) counts[item.category] += 1;
  return counts;
}
