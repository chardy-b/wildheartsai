import type {
  AllergyIntolerance,
  CodeableConcept,
  Condition,
  Encounter,
  Immunization,
  MedicationRequest,
  Observation,
  Resource,
} from "./types";

export type RecordCategory = "condition" | "medication" | "allergy" | "lab" | "immunization" | "visit";

export type RecordItem = {
  key: string;
  category: RecordCategory;
  title: string;
  date: string | null;
  detail: string | null;
  status: string | null;
  source: string;
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
  fields: Omit<RecordItem, "key" | "source">,
): RecordItem {
  return { key: `${source}|${resource.resourceType}/${resource.id ?? "unknown"}`, source, ...fields };
}

export function normalizeCondition(r: Condition, source: string): RecordItem {
  return item(r, source, {
    category: "condition",
    title: textOf(r.code) ?? "Unnamed condition",
    date: r.onsetDateTime ?? r.recordedDate ?? null,
    detail: null,
    status: codeOf(r.clinicalStatus),
  });
}

export function normalizeMedication(r: MedicationRequest, source: string): RecordItem {
  return item(r, source, {
    category: "medication",
    title: textOf(r.medicationCodeableConcept) ?? r.medicationReference?.display ?? "Unnamed medication",
    date: r.authoredOn ?? null,
    detail: r.dosageInstruction?.find((d) => d.text)?.text ?? null,
    status: r.status ?? null,
  });
}

export function normalizeAllergy(r: AllergyIntolerance, source: string): RecordItem {
  const reaction = textOf(r.reaction?.[0]?.manifestation?.[0]);
  return item(r, source, {
    category: "allergy",
    title: textOf(r.code) ?? "Unnamed allergy",
    date: r.recordedDate ?? null,
    detail: reaction ? `Reaction: ${reaction}` : null,
    status: codeOf(r.clinicalStatus),
  });
}

export function normalizeLab(r: Observation, source: string): RecordItem {
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

export function normalizeImmunization(r: Immunization, source: string): RecordItem {
  return item(r, source, {
    category: "immunization",
    title: textOf(r.vaccineCode) ?? "Unnamed immunization",
    date: r.occurrenceDateTime ?? null,
    detail: null,
    status: r.status ?? null,
  });
}

export function normalizeVisit(r: Encounter, source: string): RecordItem {
  return item(r, source, {
    category: "visit",
    title: textOf(r.type?.[0]) ?? r.class?.display ?? "Visit",
    date: r.period?.start ?? null,
    detail: r.serviceProvider?.display ?? null,
    status: r.status ?? null,
  });
}
