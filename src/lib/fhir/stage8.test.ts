import { describe, expect, it } from "vitest";
import { describeResource } from "./describe";
import { normalizeAppointment, normalizeFamilyHistory } from "./normalize";

describe("appointments", () => {
  it("reads the type, time, clinician and place", () => {
    const appointment = {
      resourceType: "Appointment",
      id: "ap1",
      status: "booked",
      serviceType: [{ text: "Follow-up visit" }],
      start: "2026-10-14T16:00:00Z",
      participant: [
        { actor: { reference: "Patient/p1", display: "Camila Lopez" } },
        { actor: { reference: "Practitioner/pr1", display: "Dr. Aria Chen" } },
        { actor: { reference: "Location/l1", display: "Northside Cardiology" } },
      ],
    } as never;
    expect(normalizeAppointment(appointment, "North")).toMatchObject({
      category: "appointment",
      title: "Follow-up visit",
      date: "2026-10-14T16:00:00Z",
      detail: "With Dr. Aria Chen · At Northside Cardiology",
      status: "booked",
    });
    expect(describeResource(appointment).map((s) => s.label)).toEqual(expect.arrayContaining(["Type", "Starts", "With", "Status"]));
  });

  it("falls back to a plain title", () => {
    expect(normalizeAppointment({ resourceType: "Appointment", id: "x" } as never, "North")).toMatchObject({ title: "Appointment", detail: null });
  });
});

describe("family history", () => {
  it("reads the relative and each condition, with age of onset", () => {
    const history = {
      resourceType: "FamilyMemberHistory",
      id: "f1",
      status: "completed",
      relationship: { text: "Mother" },
      condition: [{ code: { text: "Breast cancer" }, onsetAge: { value: 45, unit: "a" } }, { code: { text: "Hypertension" } }],
    } as never;
    expect(normalizeFamilyHistory(history, "North")).toMatchObject({
      category: "familyHistory",
      title: "Mother: Breast cancer (age 45), Hypertension",
      status: null,
    });
  });

  it("shows the relative alone when no condition is recorded", () => {
    expect(normalizeFamilyHistory({ resourceType: "FamilyMemberHistory", id: "f2", relationship: { text: "Father" }, status: "partial" } as never, "North")).toMatchObject({
      title: "Father",
      status: "partial",
    });
  });
});
