import { describe, expect, it } from "vitest";
import { describeResource, readableValue } from "./describe";
import type { Resource } from "./types";

const r = (resource: Record<string, unknown>) => resource as Resource;

describe("readableValue", () => {
  it("turns FHIR data types into plain text", () => {
    expect(readableValue({ text: "Asthma", coding: [{ display: "Asthma (disorder)" }] })).toBe("Asthma");
    expect(readableValue({ coding: [{ code: "active" }] })).toBe("active");
    expect(readableValue({ display: "Dr. Rivera", reference: "Practitioner/1" })).toBe("Dr. Rivera");
    expect(readableValue({ value: 6.1, unit: "%" })).toBe("6.1 %");
    expect(readableValue({ low: { value: 4, unit: "%" }, high: { value: 5.6, unit: "%" } })).toBe("4 % to 5.6 %");
    expect(readableValue({ start: "2024-03-14", end: "2024-03-15" })).toBe("Mar 14, 2024 to Mar 15, 2024");
    expect(readableValue({ text: "Patient reports improvement." })).toBe("Patient reports improvement.");
    expect(readableValue(3)).toBe("3");
    expect(readableValue(true)).toBe("Yes");
    expect(readableValue({ unknownShape: 1 })).toBeNull();
  });
});

describe("describeResource", () => {
  it("lays out a visit: reason, diagnoses, clinicians, location and times", () => {
    const sections = describeResource(
      r({
        resourceType: "Encounter",
        status: "finished",
        class: { display: "Office Visit", code: "AMB" },
        type: [{ text: "Office Visit" }],
        period: { start: "2023-06-02T14:00:00Z", end: "2023-06-02T14:40:00Z" },
        reasonCode: [{ text: "Follow-up" }],
        diagnosis: [{ condition: { display: "Type 2 diabetes" } }, { condition: { display: "Hypertension" } }],
        participant: [{ individual: { display: "Dr. Rivera" } }],
        location: [{ location: { display: "Main Street Clinic" } }],
      }),
    );
    expect(sections).toEqual([
      { label: "Type", values: ["Office Visit"] },
      { label: "Kind of visit", values: ["Office Visit"] },
      { label: "Reason", values: ["Follow-up"] },
      { label: "Diagnoses", values: ["Type 2 diabetes", "Hypertension"] },
      { label: "Seen by", values: ["Dr. Rivera"] },
      { label: "Where", values: ["Main Street Clinic"] },
      { label: "Started", values: ["Jun 2, 2023"] },
      { label: "Ended", values: ["Jun 2, 2023"] },
      { label: "Status", values: ["finished"] },
    ]);
  });

  it("lays out a lab result with its reference range and the health system's flag", () => {
    const sections = describeResource(
      r({
        resourceType: "Observation",
        code: { text: "Hemoglobin A1c" },
        valueQuantity: { value: 6.1, unit: "%" },
        referenceRange: [{ low: { value: 4, unit: "%" }, high: { value: 5.6, unit: "%" } }],
        interpretation: [{ text: "High" }],
        effectiveDateTime: "2025-06-19",
        specimen: { display: "Blood" },
      }),
    );
    expect(sections).toContainEqual({ label: "Result", values: ["6.1 %"] });
    expect(sections).toContainEqual({ label: "Reference range", values: ["4 % to 5.6 %"] });
    expect(sections).toContainEqual({ label: "Flagged by your health system", values: ["High"] });
    expect(sections).toContainEqual({ label: "Specimen", values: ["Blood"] });
  });

  it("shows each part of a multi-part result", () => {
    const sections = describeResource(
      r({
        resourceType: "Observation",
        component: [
          { code: { text: "Systolic" }, valueQuantity: { value: 120, unit: "mm[Hg]" } },
          { code: { text: "Diastolic" }, valueQuantity: { value: 80, unit: "mm[Hg]" } },
        ],
      }),
    );
    expect(sections).toContainEqual({ label: "Parts", values: ["Systolic: 120 mm[Hg]", "Diastolic: 80 mm[Hg]"] });
  });

  it("lays out a prescription and a report", () => {
    expect(
      describeResource(
        r({
          resourceType: "MedicationRequest",
          medicationReference: { display: "Metformin 500 MG" },
          dosageInstruction: [{ text: "Take 1 tablet twice daily", route: { text: "Oral" } }],
          requester: { display: "Dr. Chen" },
          reasonCode: [{ text: "Type 2 diabetes" }],
          dispenseRequest: { numberOfRepeatsAllowed: 3, quantity: { value: 60, unit: "tablet" } },
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        { label: "How to take it", values: ["Take 1 tablet twice daily"] },
        { label: "Route", values: ["Oral"] },
        { label: "Prescribed by", values: ["Dr. Chen"] },
        { label: "Reason", values: ["Type 2 diabetes"] },
        { label: "Refills", values: ["3"] },
        { label: "Quantity", values: ["60 tablet"] },
      ]),
    );
    expect(
      describeResource(
        r({ resourceType: "DiagnosticReport", conclusion: "No acute findings.", result: [{ display: "Hemoglobin" }, { display: "Platelets" }], category: [{ text: "Imaging" }] }),
      ),
    ).toEqual(
      expect.arrayContaining([
        { label: "Conclusion", values: ["No acute findings."] },
        { label: "Results in this report", values: ["Hemoglobin", "Platelets"] },
        { label: "Category", values: ["Imaging"] },
      ]),
    );
  });

  it("leaves out anything the health system didn't send", () => {
    expect(describeResource(r({ resourceType: "Immunization", vaccineCode: { text: "Influenza" } }))).toEqual([{ label: "Vaccine", values: ["Influenza"] }]);
    expect(describeResource(r({ resourceType: "Basic" }))).toEqual([]);
  });
});
