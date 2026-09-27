import { describe, expect, it } from "vitest";
import { describeResource } from "./describe";
import { quantityText, readableUnit } from "./format";
import { normalizeAllergy, normalizeLab, normalizeVital } from "./normalize";

describe("readable units", () => {
  it("shows common medical unit codes the way people write them", () => {
    expect(readableUnit("Cel")).toBe("°C");
    expect(readableUnit("[degF]")).toBe("°F");
    expect(readableUnit("mm[Hg]")).toBe("mmHg");
    expect(readableUnit("[lb_av]")).toBe("lb");
    expect(readableUnit("kg")).toBe("kg");
    expect(readableUnit(undefined)).toBe("");
    expect(quantityText({ value: 37.2, unit: "Cel" })).toBe("37.2 °C");
    expect(quantityText({ value: 5.1 })).toBe("5.1");
    expect(quantityText(undefined)).toBeNull();
  });

  it("applies to record summaries, blood pressure and the detail view", () => {
    const temp = { resourceType: "Observation", id: "t", code: { text: "Temperature" }, valueQuantity: { value: 37.2, unit: "Cel" } } as never;
    expect(normalizeVital(temp, "North").detail).toBe("37.2 °C");
    expect(normalizeLab(temp, "North").detail).toBe("37.2 °C");
    const bp = {
      resourceType: "Observation",
      id: "bp",
      code: { text: "Blood pressure" },
      component: [{ valueQuantity: { value: 120, unit: "mm[Hg]" } }, { valueQuantity: { value: 80, unit: "mm[Hg]" } }],
    } as never;
    expect(normalizeVital(bp, "North").detail).toBe("120/80 mmHg");
    expect(JSON.stringify(describeResource(temp))).toContain("37.2 °C");
  });
});

describe("no-allergy placeholders", () => {
  const allergy = (code: string, text: string) =>
    ({ resourceType: "AllergyIntolerance", id: "a", clinicalStatus: { coding: [{ code: "active" }] }, code: { text, coding: [{ system: "http://snomed.info/sct", code }] } }) as never;

  it("reads Epic's 'Not on File' and 'no known allergy' codes as what they mean, not as allergies", () => {
    expect(normalizeAllergy(allergy("1631000175102", "Not on File"), "North")).toMatchObject({ title: "No allergies on file", status: null });
    expect(normalizeAllergy(allergy("716186003", "NKA"), "North")).toMatchObject({ title: "No known allergies", status: null });
    expect(normalizeAllergy(allergy("409137002", "NKDA"), "North").title).toBe("No known drug allergies");
  });

  it("leaves real allergies as recorded", () => {
    expect(normalizeAllergy(allergy("91936005", "Penicillin"), "North")).toMatchObject({ title: "Penicillin", status: "active" });
  });
});
