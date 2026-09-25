import { formatRecordDate } from "./format";
import type { Resource } from "./types";

export type DetailSection = { label: string; values: string[] };

type Field = {
  label: string;
  // Dot paths into the resource; arrays along the way are flattened.
  paths: string[];
  date?: boolean;
  read?: (value: unknown) => string | null;
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function at(root: unknown, path: string): unknown[] {
  let current: unknown[] = [root];
  for (const key of path.split(".")) {
    current = current.flatMap((value) => {
      const next = isObject(value) ? value[key] : undefined;
      return Array.isArray(next) ? next : next === undefined || next === null ? [] : [next];
    });
  }
  return current;
}

// Plain text for the FHIR data types that appear in records: codes, references,
// quantities, ranges, periods and notes. Anything else is left to "All fields".
export function readableValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (!isObject(value)) return null;
  if (typeof value.text === "string" && value.text.trim()) return value.text.trim();
  if (Array.isArray(value.coding)) {
    const codings = value.coding.filter(isObject);
    const shown = codings.find((c) => typeof c.display === "string") ?? codings.find((c) => typeof c.code === "string");
    return shown ? String(shown.display ?? shown.code) : null;
  }
  if (typeof value.display === "string") return value.display;
  if (typeof value.value === "number" || typeof value.value === "string") {
    return `${value.value} ${typeof value.unit === "string" ? value.unit : ""}`.trim();
  }
  if ("low" in value || "high" in value) {
    const [low, high] = [readableValue(value.low), readableValue(value.high)];
    return low && high ? `${low} to ${high}` : low ? `At least ${low}` : high ? `Up to ${high}` : null;
  }
  if (typeof value.start === "string" || typeof value.end === "string") {
    const [start, end] = [value.start, value.end].map((d) => (typeof d === "string" ? formatRecordDate(d) : null));
    return start && end ? `${start} to ${end}` : (start ?? `Until ${end}`);
  }
  if (typeof value.code === "string") return value.code;
  return null;
}

// Result values: a quantity, text or code, whichever the health system used.
const RESULT_PATHS = ["valueQuantity", "valueString", "valueCodeableConcept", "valueBoolean", "valueInteger", "valueRange", "valuePeriod"];

function componentText(value: unknown): string | null {
  if (!isObject(value)) return null;
  const name = readableValue(value.code);
  const result = RESULT_PATHS.map((p) => readableValue(value[p])).find(Boolean);
  return result ? (name ? `${name}: ${result}` : result) : null;
}

const f = (label: string, paths: string | string[], options: Omit<Field, "label" | "paths"> = {}): Field => ({
  label,
  paths: Array.isArray(paths) ? paths : [paths],
  ...options,
});
const notes = f("Notes", "note");
const status = f("Status", "status");

const OBSERVATION: Field[] = [
  f("Test", "code"),
  f("Result", RESULT_PATHS),
  f("Parts", "component", { read: componentText }),
  f("Reference range", "referenceRange"),
  f("Flagged by your health system", "interpretation"),
  f("Category", "category"),
  f("Collected", "effectiveDateTime", { date: true }),
  f("Resulted", "issued", { date: true }),
  f("Specimen", "specimen"),
  f("Performed by", "performer"),
  notes,
  status,
];

const FIELDS: Record<string, Field[]> = {
  Condition: [
    f("Condition", "code"),
    f("Category", "category"),
    f("Clinical status", "clinicalStatus"),
    f("Verification", "verificationStatus"),
    f("Severity", "severity"),
    f("Body site", "bodySite"),
    f("Started", ["onsetDateTime", "onsetPeriod"], { date: true }),
    f("Resolved", ["abatementDateTime", "abatementPeriod"], { date: true }),
    f("Recorded", "recordedDate", { date: true }),
    f("Recorded by", "recorder"),
    notes,
  ],
  MedicationRequest: [
    f("Medication", ["medicationCodeableConcept", "medicationReference"]),
    f("How to take it", "dosageInstruction.text"),
    f("Route", "dosageInstruction.route"),
    f("Prescribed", "authoredOn", { date: true }),
    f("Prescribed by", "requester"),
    f("Reason", ["reasonCode", "reasonReference"]),
    f("Refills", "dispenseRequest.numberOfRepeatsAllowed"),
    f("Quantity", "dispenseRequest.quantity"),
    f("Supply", "dispenseRequest.expectedSupplyDuration"),
    f("Intent", "intent"),
    notes,
    status,
  ],
  AllergyIntolerance: [
    f("Allergy", "code"),
    f("Reactions", "reaction.manifestation"),
    f("Reaction severity", "reaction.severity"),
    f("Criticality", "criticality"),
    f("Type", "type"),
    f("Category", "category"),
    f("Clinical status", "clinicalStatus"),
    f("Verification", "verificationStatus"),
    f("Started", "onsetDateTime", { date: true }),
    f("Recorded", "recordedDate", { date: true }),
    notes,
  ],
  Observation: OBSERVATION,
  Immunization: [
    f("Vaccine", "vaccineCode"),
    f("Given", "occurrenceDateTime", { date: true }),
    f("Dose in series", ["protocolApplied.doseNumberPositiveInt", "protocolApplied.doseNumberString"]),
    f("Site", "site"),
    f("Route", "route"),
    f("Lot number", "lotNumber"),
    f("Given by", "performer.actor"),
    f("Where", "location"),
    notes,
    f("Status", "status"),
  ],
  Encounter: [
    f("Type", "type"),
    f("Kind of visit", "class"),
    f("Reason", ["reasonCode", "reasonReference"]),
    f("Diagnoses", "diagnosis.condition"),
    f("Seen by", "participant.individual"),
    f("Where", "location.location"),
    f("Department", "serviceProvider"),
    f("Started", "period.start", { date: true }),
    f("Ended", "period.end", { date: true }),
    f("Admitted from", "hospitalization.admitSource"),
    f("Discharged to", "hospitalization.dischargeDisposition"),
    status,
  ],
  DiagnosticReport: [
    f("Report", "code"),
    f("Category", "category"),
    f("Conclusion", "conclusion"),
    f("Results in this report", "result"),
    f("Performed by", ["performer", "resultsInterpreter"]),
    f("Date", "effectiveDateTime", { date: true }),
    f("Issued", "issued", { date: true }),
    status,
  ],
  DocumentReference: [
    f("Document", "type"),
    f("Category", "category"),
    f("Description", "description"),
    f("Author", "author"),
    f("Visit dates", "context.period"),
    f("Date", "date", { date: true }),
    f("Status", ["docStatus", "status"]),
  ],
  Procedure: [
    f("Procedure", "code"),
    f("Performed", ["performedDateTime", "performedPeriod"], { date: true }),
    f("Reason", ["reasonCode", "reasonReference"]),
    f("Body site", "bodySite"),
    f("Performed by", "performer.actor"),
    f("Where", "location"),
    f("Outcome", "outcome"),
    notes,
    status,
  ],
  CareTeam: [f("Team", "name"), f("Members", "participant.member"), f("Roles", "participant.role"), f("Period", "period"), status],
  CarePlan: [
    f("Plan", "title"),
    f("Category", "category"),
    f("Description", "description"),
    f("Activities", ["activity.detail.code", "activity.detail.description"]),
    f("Period", "period"),
    f("Created", "created", { date: true }),
    notes,
    status,
  ],
  Goal: [
    f("Goal", "description"),
    f("Target", ["target.detailQuantity", "target.detailString", "target.detailRange"]),
    f("Target date", "target.dueDate", { date: true }),
    f("Started", "startDate", { date: true }),
    f("Achievement", "achievementStatus"),
    notes,
    f("Status", "lifecycleStatus"),
  ],
  ServiceRequest: [
    f("Order", "code"),
    f("Category", "category"),
    f("Ordered", "authoredOn", { date: true }),
    f("Ordered by", "requester"),
    f("Reason", ["reasonCode", "reasonReference"]),
    f("Priority", "priority"),
    f("Instructions", "patientInstruction"),
    notes,
    status,
  ],
  MedicationDispense: [
    f("Medication", ["medicationCodeableConcept", "medicationReference"]),
    f("Picked up", "whenHandedOver", { date: true }),
    f("Prepared", "whenPrepared", { date: true }),
    f("Quantity", "quantity"),
    f("Days supply", "daysSupply"),
    f("How to take it", "dosageInstruction.text"),
    status,
  ],
  Device: [f("Device", ["deviceName.name", "type"]), f("Manufacturer", "manufacturer"), f("Model", "modelNumber"), f("Device ID", "udiCarrier.deviceIdentifier"), status],
  Coverage: [f("Payer", "payor"), f("Plan type", "type"), f("Relationship", "relationship"), f("Period", "period"), status],
};

// The readable part of a record's expanded view. "All fields" shows the rest.
export function describeResource(resource: Resource): DetailSection[] {
  const sections: DetailSection[] = [];
  for (const field of FIELDS[resource.resourceType] ?? []) {
    const raw = field.paths.flatMap((path) => at(resource, path));
    const values = raw
      .map((value) => (field.read ? field.read(value) : field.date && typeof value === "string" ? formatRecordDate(value) : readableValue(value)))
      .filter((value): value is string => Boolean(value));
    const unique = [...new Set(values)];
    if (unique.length) sections.push({ label: field.label, values: unique });
  }
  return sections;
}
