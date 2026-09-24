import { describe, expect, it } from "vitest";
import {
  normalizeAllergy,
  normalizeCondition,
  normalizeImmunization,
  normalizeLab,
  normalizeMedication,
  normalizeVisit,
} from "./normalize";

const source = "Example Health";

describe("normalizers", () => {
  it("reads a condition, preferring text over coding", () => {
    expect(
      normalizeCondition(
        {
          resourceType: "Condition",
          id: "c1",
          code: { text: "Type 2 diabetes", coding: [{ display: "Diabetes mellitus type 2" }] },
          clinicalStatus: { coding: [{ code: "active" }] },
          onsetDateTime: "2021-05-02",
        },
        source,
      ),
    ).toEqual({
      key: "Example Health|Condition/c1",
      category: "condition",
      title: "Type 2 diabetes",
      date: "2021-05-02",
      detail: null,
      status: "active",
      source,
    });
  });

  it("falls back to coding display, then to a neutral title", () => {
    expect(normalizeCondition({ resourceType: "Condition", id: "c2", code: { coding: [{ display: "Asthma" }] } }, source).title).toBe("Asthma");
    expect(normalizeCondition({ resourceType: "Condition", id: "c3" }, source).title).toBe("Unnamed condition");
  });

  it("reads a medication with its dosage instructions", () => {
    const item = normalizeMedication(
      {
        resourceType: "MedicationRequest",
        id: "m1",
        status: "active",
        medicationReference: { display: "Lisinopril 10 MG Oral Tablet" },
        authoredOn: "2025-06-19T14:00:00Z",
        dosageInstruction: [{ text: "Take 1 tablet by mouth daily" }],
      },
      source,
    );
    expect(item).toMatchObject({
      category: "medication",
      title: "Lisinopril 10 MG Oral Tablet",
      detail: "Take 1 tablet by mouth daily",
      status: "active",
    });
  });

  it("reads an allergy and its reaction", () => {
    const item = normalizeAllergy(
      {
        resourceType: "AllergyIntolerance",
        id: "a1",
        code: { text: "Penicillin" },
        reaction: [{ manifestation: [{ text: "Hives" }] }],
        clinicalStatus: { coding: [{ code: "active" }] },
      },
      source,
    );
    expect(item).toMatchObject({ category: "allergy", title: "Penicillin", detail: "Reaction: Hives", status: "active" });
  });

  it("reads a lab value with units and the health system's interpretation", () => {
    const item = normalizeLab(
      {
        resourceType: "Observation",
        id: "o1",
        status: "final",
        code: { text: "Hemoglobin A1c" },
        effectiveDateTime: "2025-06-19T09:10:00Z",
        valueQuantity: { value: 6.1, unit: "%" },
        interpretation: [{ text: "High" }],
      },
      source,
    );
    expect(item).toMatchObject({ category: "lab", title: "Hemoglobin A1c", detail: "6.1 %", status: "High" });
  });

  it("reads text lab values", () => {
    const item = normalizeLab(
      { resourceType: "Observation", id: "o2", code: { text: "Urine color" }, valueString: "Yellow", issued: "2024-01-02T00:00:00Z" },
      source,
    );
    expect(item).toMatchObject({ detail: "Yellow", date: "2024-01-02T00:00:00Z", status: null });
  });

  it("reads immunizations and visits", () => {
    expect(
      normalizeImmunization({ resourceType: "Immunization", id: "i1", vaccineCode: { text: "Influenza" }, occurrenceDateTime: "2024-10-01", status: "completed" }, source),
    ).toMatchObject({ category: "immunization", title: "Influenza", date: "2024-10-01" });
    expect(
      normalizeVisit(
        { resourceType: "Encounter", id: "e1", type: [{ text: "Office Visit" }], period: { start: "2025-06-19T08:30:00Z" }, serviceProvider: { display: "Primary Care Clinic" } },
        source,
      ),
    ).toMatchObject({ category: "visit", title: "Office Visit", detail: "Primary Care Clinic", date: "2025-06-19T08:30:00Z" });
  });
});
