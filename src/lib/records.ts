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
  type RecordSummary,
} from "@/lib/fhir/normalize";

type Query = {
  category: RecordCategory;
  resourceType: string;
  path: (patientId: string) => string;
  normalize: (resource: never, source: string) => RecordSummary;
};

const patient = (id: string) => `patient=${encodeURIComponent(id)}`;

// Every resource type the dashboard displays, and nothing else (issue #11). The sync
// engine (src/lib/sync/plan.ts) runs these searches and stores the results.
// Epic requires a category on Condition, Observation, DocumentReference and CarePlan searches.
export const RECORD_QUERIES: Query[] = [
  { category: "condition", resourceType: "Condition", path: (p) => `Condition?${patient(p)}&category=problem-list-item`, normalize: normalizeCondition },
  { category: "medication", resourceType: "MedicationRequest", path: (p) => `MedicationRequest?${patient(p)}`, normalize: normalizeMedication },
  { category: "allergy", resourceType: "AllergyIntolerance", path: (p) => `AllergyIntolerance?${patient(p)}`, normalize: normalizeAllergy },
  { category: "lab", resourceType: "Observation", path: (p) => `Observation?${patient(p)}&category=laboratory`, normalize: normalizeLab },
  { category: "immunization", resourceType: "Immunization", path: (p) => `Immunization?${patient(p)}`, normalize: normalizeImmunization },
  { category: "visit", resourceType: "Encounter", path: (p) => `Encounter?${patient(p)}`, normalize: normalizeVisit },
  { category: "report", resourceType: "DiagnosticReport", path: (p) => `DiagnosticReport?${patient(p)}`, normalize: normalizeReport },
  { category: "note", resourceType: "DocumentReference", path: (p) => `DocumentReference?${patient(p)}&category=clinical-note`, normalize: normalizeNote },
  { category: "procedure", resourceType: "Procedure", path: (p) => `Procedure?${patient(p)}`, normalize: normalizeProcedure },
  { category: "vital", resourceType: "Observation", path: (p) => `Observation?${patient(p)}&category=vital-signs`, normalize: normalizeVital },
  { category: "social", resourceType: "Observation", path: (p) => `Observation?${patient(p)}&category=social-history`, normalize: normalizeSocial },
  { category: "careTeam", resourceType: "CareTeam", path: (p) => `CareTeam?${patient(p)}`, normalize: normalizeCareTeam },
  // 38717003: SNOMED "Longitudinal care plan", the category Epic supports for patients.
  { category: "carePlan", resourceType: "CarePlan", path: (p) => `CarePlan?${patient(p)}&category=38717003`, normalize: normalizeCarePlan },
  { category: "goal", resourceType: "Goal", path: (p) => `Goal?${patient(p)}`, normalize: normalizeGoal },
  { category: "order", resourceType: "ServiceRequest", path: (p) => `ServiceRequest?${patient(p)}`, normalize: normalizeOrder },
  { category: "fill", resourceType: "MedicationDispense", path: (p) => `MedicationDispense?${patient(p)}`, normalize: normalizeFill },
  { category: "device", resourceType: "Device", path: (p) => `Device?${patient(p)}`, normalize: normalizeDevice },
  { category: "coverage", resourceType: "Coverage", path: (p) => `Coverage?${patient(p)}`, normalize: normalizeCoverage },
];

// Something the person should know about one of their sources, shown above their records.
export type RecordProblem =
  | { organizationName: string; kind: "reconnect" | "unavailable" | "importing" }
  | { organizationName: string; kind: "partial"; categories: RecordCategory[] };
