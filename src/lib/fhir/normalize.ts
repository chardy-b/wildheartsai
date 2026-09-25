import type {
  AllergyIntolerance,
  CarePlan,
  CareTeam,
  CodeableConcept,
  Condition,
  Coverage,
  Device,
  DiagnosticReport,
  DocumentReference,
  Encounter,
  Goal,
  Immunization,
  MedicationDispense,
  MedicationRequest,
  Observation,
  Procedure,
  Quantity,
  Resource,
  ServiceRequest,
} from "./types";

export type RecordCategory =
  | "condition"
  | "medication"
  | "allergy"
  | "lab"
  | "immunization"
  | "visit"
  | "report"
  | "note"
  | "procedure"
  | "vital"
  | "social"
  | "careTeam"
  | "carePlan"
  | "goal"
  | "order"
  | "fill"
  | "device"
  | "coverage";

// One row as shown in a list. Normalizers produce this from a FHIR resource.
export type RecordSummary = {
  key: string;
  category: RecordCategory;
  title: string;
  date: string | null;
  detail: string | null;
  status: string | null;
  source: string;
};

// A row plus the resource it came from (rendered in the expanded detail, never
// stored) and the connection that fetched it (needed to load a note's text).
export type RecordItem = RecordSummary & { resource: Resource; connectionId: string };

function textOf(concept: CodeableConcept | undefined): string | null {
  return concept?.text?.trim() || concept?.coding?.find((c) => c.display)?.display?.trim() || null;
}

function codeOf(concept: CodeableConcept | undefined): string | null {
  return concept?.coding?.find((c) => c.code)?.code ?? null;
}

function item(
  resource: Resource,
  source: string,
  fields: Omit<RecordSummary, "key" | "source">,
): RecordSummary {
  return { key: `${source}|${resource.resourceType}/${resource.id ?? "unknown"}`, source, ...fields };
}

export function normalizeCondition(r: Condition, source: string): RecordSummary {
  return item(r, source, {
    category: "condition",
    title: textOf(r.code) ?? "Unnamed condition",
    date: r.onsetDateTime ?? r.recordedDate ?? null,
    detail: null,
    status: codeOf(r.clinicalStatus),
  });
}

export function normalizeMedication(r: MedicationRequest, source: string): RecordSummary {
  return item(r, source, {
    category: "medication",
    title: textOf(r.medicationCodeableConcept) ?? r.medicationReference?.display ?? "Unnamed medication",
    date: r.authoredOn ?? null,
    detail: r.dosageInstruction?.find((d) => d.text)?.text ?? null,
    status: r.status ?? null,
  });
}

export function normalizeAllergy(r: AllergyIntolerance, source: string): RecordSummary {
  const reaction = textOf(r.reaction?.[0]?.manifestation?.[0]);
  return item(r, source, {
    category: "allergy",
    title: textOf(r.code) ?? "Unnamed allergy",
    date: r.recordedDate ?? null,
    detail: reaction ? `Reaction: ${reaction}` : null,
    status: codeOf(r.clinicalStatus),
  });
}

export function normalizeLab(r: Observation, source: string): RecordSummary {
  const quantity = r.valueQuantity?.value !== undefined ? `${r.valueQuantity.value} ${r.valueQuantity.unit ?? ""}`.trim() : null;
  return item(r, source, {
    category: "lab",
    title: textOf(r.code) ?? "Unnamed result",
    date: r.effectiveDateTime ?? r.issued ?? null,
    detail: quantity ?? r.valueString ?? textOf(r.valueCodeableConcept),
    // The health system's own interpretation (for example "High"), shown as recorded.
    status: textOf(r.interpretation?.[0]),
  });
}

export function normalizeImmunization(r: Immunization, source: string): RecordSummary {
  return item(r, source, {
    category: "immunization",
    title: textOf(r.vaccineCode) ?? "Unnamed immunization",
    date: r.occurrenceDateTime ?? null,
    detail: null,
    status: r.status ?? null,
  });
}

export function normalizeVisit(r: Encounter, source: string): RecordSummary {
  return item(r, source, {
    category: "visit",
    title: textOf(r.type?.[0]) ?? r.class?.display ?? "Visit",
    date: r.period?.start ?? null,
    detail: r.serviceProvider?.display ?? null,
    status: r.status ?? null,
  });
}

function quantityText(q: Quantity | undefined): string | null {
  return q?.value !== undefined ? `${q.value} ${q.unit ?? ""}`.trim() : null;
}

function joined(values: (string | null | undefined)[]): string | null {
  const present = values.filter((v): v is string => Boolean(v?.trim()));
  return present.length ? present.join(", ") : null;
}

export function normalizeReport(r: DiagnosticReport, source: string): RecordSummary {
  return item(r, source, {
    category: "report",
    title: textOf(r.code) ?? "Report",
    date: r.effectiveDateTime ?? r.issued ?? null,
    detail: r.conclusion?.trim() || textOf(r.category?.[0]),
    status: r.status ?? null,
  });
}

export function normalizeNote(r: DocumentReference, source: string): RecordSummary {
  const author = joined((r.author ?? []).map((a) => a.display));
  return item(r, source, {
    category: "note",
    title: textOf(r.type) ?? r.description?.trim() ?? "Document",
    date: r.context?.period?.start ?? r.date ?? null,
    detail: author ? `By ${author}` : null,
    status: r.docStatus ?? r.status ?? null,
  });
}

export function normalizeProcedure(r: Procedure, source: string): RecordSummary {
  const reason = textOf(r.reasonCode?.[0]);
  return item(r, source, {
    category: "procedure",
    title: textOf(r.code) ?? "Procedure",
    date: r.performedDateTime ?? r.performedPeriod?.start ?? null,
    detail: reason ? `For ${reason}` : null,
    status: r.status ?? null,
  });
}

// Vitals are often two-part (blood pressure), so components are read as "120/80 mm[Hg]".
function observationValue(r: Observation): string | null {
  const parts = (r.component ?? []).map((c) => c.valueQuantity).filter((q): q is Quantity => q?.value !== undefined);
  if (parts.length > 1) return `${parts.map((q) => q.value).join("/")} ${parts[0].unit ?? ""}`.trim();
  return quantityText(r.valueQuantity) ?? r.valueString ?? textOf(r.valueCodeableConcept);
}

export function normalizeVital(r: Observation, source: string): RecordSummary {
  return item(r, source, {
    category: "vital",
    title: textOf(r.code) ?? "Vital sign",
    date: r.effectiveDateTime ?? r.issued ?? null,
    detail: observationValue(r),
    status: textOf(r.interpretation?.[0]),
  });
}

export function normalizeSocial(r: Observation, source: string): RecordSummary {
  return item(r, source, {
    category: "social",
    title: textOf(r.code) ?? "Social history",
    date: r.effectiveDateTime ?? r.issued ?? null,
    detail: observationValue(r),
    status: null,
  });
}

export function normalizeCareTeam(r: CareTeam, source: string): RecordSummary {
  return item(r, source, {
    category: "careTeam",
    title: r.name?.trim() || "Care team",
    date: r.period?.start ?? null,
    detail: joined((r.participant ?? []).map((p) => p.member?.display)),
    status: r.status ?? null,
  });
}

export function normalizeCarePlan(r: CarePlan, source: string): RecordSummary {
  return item(r, source, {
    category: "carePlan",
    title: r.title?.trim() || textOf(r.category?.[0]) || "Care plan",
    date: r.period?.start ?? r.created ?? null,
    detail: r.description?.trim() || null,
    status: r.status ?? null,
  });
}

export function normalizeGoal(r: Goal, source: string): RecordSummary {
  const due = r.target?.find((t) => t.dueDate)?.dueDate;
  return item(r, source, {
    category: "goal",
    title: textOf(r.description) ?? "Goal",
    date: r.startDate ?? null,
    detail: due ? `Target date ${due}` : null,
    status: r.lifecycleStatus ?? null,
  });
}

export function normalizeOrder(r: ServiceRequest, source: string): RecordSummary {
  return item(r, source, {
    category: "order",
    title: textOf(r.code) ?? "Order",
    date: r.authoredOn ?? null,
    detail: r.requester?.display ? `Ordered by ${r.requester.display}` : null,
    status: r.status ?? null,
  });
}

export function normalizeFill(r: MedicationDispense, source: string): RecordSummary {
  const days = r.daysSupply?.value !== undefined ? `${r.daysSupply.value} days supply` : null;
  return item(r, source, {
    category: "fill",
    title: textOf(r.medicationCodeableConcept) ?? r.medicationReference?.display ?? "Pharmacy fill",
    date: r.whenHandedOver ?? r.whenPrepared ?? null,
    detail: joined([quantityText(r.quantity), days]),
    status: r.status ?? null,
  });
}

export function normalizeDevice(r: Device, source: string): RecordSummary {
  return item(r, source, {
    category: "device",
    title: r.deviceName?.find((d) => d.name)?.name ?? textOf(r.type) ?? "Device",
    date: null,
    detail: r.manufacturer ? `Made by ${r.manufacturer}` : null,
    status: r.status ?? null,
  });
}

export function normalizeCoverage(r: Coverage, source: string): RecordSummary {
  return item(r, source, {
    category: "coverage",
    title: r.payor?.find((p) => p.display)?.display ?? textOf(r.type) ?? "Insurance",
    date: r.period?.start ?? null,
    detail: textOf(r.type),
    status: r.status ?? null,
  });
}
