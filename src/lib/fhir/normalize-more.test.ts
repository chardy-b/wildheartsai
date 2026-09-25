import { describe, expect, it } from "vitest";
import {
  normalizeCarePlan,
  normalizeCareTeam,
  normalizeCoverage,
  normalizeDevice,
  normalizeFill,
  normalizeGoal,
  normalizeNote,
  normalizeOrder,
  normalizeProcedure,
  normalizeReport,
  normalizeSocial,
  normalizeVital,
} from "./normalize";

const source = "Example Health";

describe("normalizers for the remaining record types", () => {
  it("reads a lab or imaging report, preferring its conclusion", () => {
    expect(
      normalizeReport(
        { resourceType: "DiagnosticReport", id: "r1", status: "final", code: { text: "XR Chest 2 Views" }, category: [{ text: "Imaging" }], effectiveDateTime: "2024-02-03", conclusion: "No acute findings." },
        source,
      ),
    ).toEqual({ key: "Example Health|DiagnosticReport/r1", category: "report", title: "XR Chest 2 Views", date: "2024-02-03", detail: "No acute findings.", status: "final", source });
    expect(normalizeReport({ resourceType: "DiagnosticReport", id: "r2", code: { text: "CBC" }, category: [{ text: "Lab" }], issued: "2024-01-01T10:00:00Z" }, source)).toMatchObject({ detail: "Lab", date: "2024-01-01T10:00:00Z" });
  });

  it("reads a note with its author and visit date", () => {
    expect(
      normalizeNote(
        { resourceType: "DocumentReference", id: "d1", docStatus: "final", type: { text: "Progress Notes" }, date: "2023-06-02T15:00:00Z", author: [{ display: "Dr. Rivera" }], context: { period: { start: "2023-06-02T14:00:00Z" } } },
        source,
      ),
    ).toMatchObject({ category: "note", title: "Progress Notes", date: "2023-06-02T14:00:00Z", detail: "By Dr. Rivera", status: "final" });
  });

  it("reads procedures, orders and pharmacy fills", () => {
    expect(normalizeProcedure({ resourceType: "Procedure", id: "p1", status: "completed", code: { text: "Appendectomy" }, performedPeriod: { start: "2019-04-01" }, reasonCode: [{ text: "Appendicitis" }] }, source)).toMatchObject({ category: "procedure", title: "Appendectomy", date: "2019-04-01", detail: "For Appendicitis" });
    expect(normalizeOrder({ resourceType: "ServiceRequest", id: "s1", status: "active", code: { text: "Lipid panel" }, authoredOn: "2025-01-10", requester: { display: "Dr. Chen" } }, source)).toMatchObject({ category: "order", title: "Lipid panel", detail: "Ordered by Dr. Chen" });
    expect(normalizeFill({ resourceType: "MedicationDispense", id: "f1", status: "completed", medicationReference: { display: "Metformin 500 MG" }, whenHandedOver: "2025-02-01", quantity: { value: 60, unit: "tablet" }, daysSupply: { value: 30, unit: "days" } }, source)).toMatchObject({ category: "fill", title: "Metformin 500 MG", detail: "60 tablet, 30 days supply" });
  });

  it("reads vitals, including two-part results like blood pressure", () => {
    expect(
      normalizeVital(
        { resourceType: "Observation", id: "v1", code: { text: "Blood Pressure" }, effectiveDateTime: "2023-06-02", component: [{ code: { text: "Systolic" }, valueQuantity: { value: 120, unit: "mm[Hg]" } }, { code: { text: "Diastolic" }, valueQuantity: { value: 80, unit: "mm[Hg]" } }] },
        source,
      ),
    ).toMatchObject({ category: "vital", title: "Blood Pressure", detail: "120/80 mm[Hg]" });
    expect(normalizeVital({ resourceType: "Observation", id: "v2", code: { text: "Pulse" }, valueQuantity: { value: 72, unit: "/min" } }, source).detail).toBe("72 /min");
    expect(normalizeSocial({ resourceType: "Observation", id: "o1", code: { text: "Tobacco use" }, valueCodeableConcept: { text: "Never smoker" } }, source)).toMatchObject({ category: "social", detail: "Never smoker" });
  });

  it("reads care teams, care plans and goals", () => {
    expect(normalizeCareTeam({ resourceType: "CareTeam", id: "t1", status: "active", participant: [{ member: { display: "Dr. Rivera" } }, { member: { display: "Nurse Kim" } }] }, source)).toMatchObject({ category: "careTeam", title: "Care team", detail: "Dr. Rivera, Nurse Kim" });
    expect(normalizeCarePlan({ resourceType: "CarePlan", id: "c1", status: "active", category: [{ text: "Longitudinal" }], period: { start: "2022-01-01" }, description: "Diabetes plan" }, source)).toMatchObject({ category: "carePlan", title: "Longitudinal", detail: "Diabetes plan", date: "2022-01-01" });
    expect(normalizeGoal({ resourceType: "Goal", id: "g1", lifecycleStatus: "active", description: { text: "A1C below 7" }, startDate: "2024-01-01", target: [{ dueDate: "2024-12-31" }] }, source)).toMatchObject({ category: "goal", title: "A1C below 7", detail: "Target date 2024-12-31", status: "active" });
  });

  it("reads devices and insurance", () => {
    expect(normalizeDevice({ resourceType: "Device", id: "dv1", status: "active", deviceName: [{ name: "Pacemaker" }], manufacturer: "Acme" }, source)).toMatchObject({ category: "device", title: "Pacemaker", date: null, detail: "Made by Acme" });
    expect(normalizeCoverage({ resourceType: "Coverage", id: "cv1", status: "active", payor: [{ display: "Blue Plan" }], type: { text: "Commercial" }, period: { start: "2025-01-01" } }, source)).toMatchObject({ category: "coverage", title: "Blue Plan", detail: "Commercial", date: "2025-01-01" });
  });

  it("falls back to neutral titles", () => {
    expect(normalizeReport({ resourceType: "DiagnosticReport", id: "x" }, source).title).toBe("Report");
    expect(normalizeNote({ resourceType: "DocumentReference", id: "x" }, source).title).toBe("Document");
    expect(normalizeDevice({ resourceType: "Device", id: "x" }, source).title).toBe("Device");
    expect(normalizeCoverage({ resourceType: "Coverage", id: "x" }, source).title).toBe("Insurance");
  });
});
