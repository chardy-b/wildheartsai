import type {
  AllergyIntolerance,
  Appointment,
  CarePlan,
  CareTeam,
  CodeableConcept,
  Condition,
  Coverage,
  Device,
  DiagnosticReport,
  DocumentReference,
  Encounter,
  FamilyMemberHistory,
  Goal,
  Immunization,
  MedicationDispense,
  MedicationRequest,
  Observation,
  Patient,
  Procedure,
  Quantity,
  Resource,
  ServiceRequest,
} from "./types";
import { quantityText, readableUnit } from "./format";

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
  | "coverage"
  | "diagnosis"
  | "concern"
  | "assessment"
  | "appointment"
  | "familyHistory";

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
export type RecordItem = RecordSummary & {
  resource: Resource;
  connectionId: string;
  // Stored records only: the organization it came from, and earlier versions it replaced (newest first).
  sourceId?: string;
  history?: { replacedAt: string; resource: Resource }[];
  // Stored records only: the medications, clinicians, organizations and locations it points to.
  linked?: { key: string; resource: Resource }[];
};

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

// Diagnoses recorded at a visit (Condition category encounter-diagnosis).
export function normalizeDiagnosis(r: Condition, source: string): RecordSummary {
  return item(r, source, {
    category: "diagnosis",
    title: textOf(r.code) ?? "Unnamed diagnosis",
    date: r.recordedDate ?? r.onsetDateTime ?? null,
    detail: null,
    status: codeOf(r.clinicalStatus),
  });
}

// Things the care team is watching (Condition category health-concern).
export function normalizeConcern(r: Condition, source: string): RecordSummary {
  return item(r, source, {
    category: "concern",
    title: textOf(r.code) ?? "Unnamed health concern",
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

// SNOMED codes health systems use in an allergy list to say there are none, or that the
// patient wasn't asked (Epic shows the latter as "Not on File"). They aren't allergies.
const NO_ALLERGY_CODES: Record<string, string> = {
  "716186003": "No known allergies",
  "409137002": "No known drug allergies",
  "429625007": "No known food allergies",
  "428607008": "No known environmental allergies",
  "1631000175102": "No allergies on file",
};

export function normalizeAllergy(r: AllergyIntolerance, source: string): RecordSummary {
  const none = (r.code?.coding ?? []).map((c) => (c.code ? NO_ALLERGY_CODES[c.code] : undefined)).find(Boolean);
  if (none) return item(r, source, { category: "allergy", title: none, date: r.recordedDate ?? null, detail: null, status: null });
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
  const quantity = quantityText(r.valueQuantity);
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

// Vitals are often two-part (blood pressure), so components are read as "120/80 mmHg".
function observationValue(r: Observation): string | null {
  const parts = (r.component ?? []).map((c) => c.valueQuantity).filter((q): q is Quantity => q?.value !== undefined);
  if (parts.length > 1) return `${parts.map((q) => q.value).join("/")} ${readableUnit(parts[0].unit)}`.trim();
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

// Questionnaire scores and screenings such as PHQ-9 (Observation category survey).
export function normalizeAssessment(r: Observation, source: string): RecordSummary {
  return item(r, source, {
    category: "assessment",
    title: textOf(r.code) ?? "Assessment",
    date: r.effectiveDateTime ?? r.issued ?? null,
    detail: observationValue(r),
    status: null,
  });
}

// A visit booked, past or upcoming. Where it takes place and with whom come from its participants.
export function normalizeAppointment(r: Appointment, source: string): RecordSummary {
  const where = (r.participant ?? []).map((p) => p.actor?.reference?.startsWith("Location/") ? p.actor.display : undefined).find(Boolean);
  const who = (r.participant ?? []).map((p) => p.actor?.reference?.startsWith("Practitioner/") ? p.actor.display : undefined).find(Boolean);
  return item(r, source, {
    category: "appointment",
    title: textOf(r.serviceType?.[0]) ?? textOf(r.appointmentType) ?? r.description?.trim() ?? "Appointment",
    date: r.start ?? null,
    detail: [who && `With ${who}`, where && `At ${where}`].filter(Boolean).join(" · ") || null,
    status: r.status ?? null,
  });
}

// "Mother: Breast cancer (age 45)": a relative and what they had.
export function normalizeFamilyHistory(r: FamilyMemberHistory, source: string): RecordSummary {
  const relative = textOf(r.relationship) ?? r.name ?? "Relative";
  const conditions = (r.condition ?? [])
    .map((c) => {
      const name = textOf(c.code);
      const age = c.onsetAge?.value !== undefined ? ` (age ${c.onsetAge.value})` : c.onsetString ? ` (${c.onsetString})` : "";
      return name ? `${name}${age}` : null;
    })
    .filter(Boolean);
  return item(r, source, {
    category: "familyHistory",
    title: conditions.length ? `${relative}: ${conditions.join(", ")}` : relative,
    date: r.date ?? null,
    detail: null,
    status: r.status === "completed" ? null : (r.status ?? null),
  });
}

// Stored rows that aren't shown as records (the patient's own details at a source) have no category.
export type StoredSummary = Omit<RecordSummary, "category"> & { category: RecordCategory | null };

// The person as a source knows them: name and birth date. Kept to match sources later; not a timeline row.
export function normalizePatient(r: Patient, source: string): StoredSummary {
  const name = r.name?.[0];
  const full = name?.text?.trim() || [...(name?.given ?? []), name?.family].filter(Boolean).join(" ") || "Patient";
  return {
    key: `${source}|Patient/${r.id ?? "unknown"}`,
    source,
    category: null,
    title: full,
    date: null,
    detail: r.birthDate ? `Born ${r.birthDate}` : null,
    status: null,
  };
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
