import { describe, expect, it } from "vitest";
import { collectReferences, referencedName, referenceKey, withNames } from "./references";

describe("referenceKey", () => {
  it("reads relative and absolute references to the types we resolve, and nothing else", () => {
    expect(referenceKey("Practitioner/abc")).toEqual({ type: "Practitioner", id: "abc", key: "Practitioner/abc" });
    expect(referenceKey("https://fhir.example/R4/Location/l-1")?.key).toBe("Location/l-1");
    expect(referenceKey("#contained")).toBeNull();
    expect(referenceKey("Patient/p1")).toBeNull();
    expect(referenceKey("Practitioner/../../x")).toBeNull();
    expect(referenceKey(undefined)).toBeNull();
  });
});

describe("collectReferences", () => {
  it("finds every referenced resource once, however deeply nested", () => {
    const order = {
      resourceType: "ServiceRequest",
      requester: { reference: "Practitioner/pr1" },
      performer: [{ reference: "Organization/o1" }, { reference: "Practitioner/pr1" }],
      subject: { reference: "Patient/p1" },
      locationReference: [{ reference: "Location/l1", display: "Clinic" }],
    };
    expect(collectReferences(order as never)).toEqual(["Practitioner/pr1", "Organization/o1", "Location/l1"]);
  });
});

describe("referencedName", () => {
  it("names each type the way records show it", () => {
    expect(referencedName({ resourceType: "Practitioner", name: [{ prefix: ["Dr."], given: ["Aria"], family: "Chen" }] } as never)).toBe("Dr. Aria Chen");
    expect(referencedName({ resourceType: "Practitioner", name: [{ text: "Aria Chen, MD" }] } as never)).toBe("Aria Chen, MD");
    expect(referencedName({ resourceType: "PractitionerRole", practitioner: { display: "Aria Chen" }, specialty: [{ text: "Cardiology" }] } as never)).toBe("Aria Chen, Cardiology");
    expect(referencedName({ resourceType: "Organization", name: "Northside Health" } as never)).toBe("Northside Health");
    expect(referencedName({ resourceType: "Medication", code: { coding: [{ display: "Metformin 500 MG Oral Tablet" }] } } as never)).toBe("Metformin 500 MG Oral Tablet");
    expect(referencedName({ resourceType: "Location" } as never)).toBeNull();
  });
});

describe("withNames", () => {
  const names = new Map([["Practitioner/pr1", "Dr. Aria Chen"]]);

  it("fills in a name only where the reference has none, without changing the original", () => {
    const record = { resourceType: "ServiceRequest", requester: { reference: "Practitioner/pr1" }, performer: [{ reference: "Practitioner/pr1", display: "Aria C." }] };
    const named = withNames(record as never, names) as typeof record;
    expect(named.requester).toEqual({ reference: "Practitioner/pr1", display: "Dr. Aria Chen" });
    expect(named.performer[0].display).toBe("Aria C.");
    expect((record.requester as { display?: string }).display).toBeUndefined();
  });

  it("returns the same object when there's nothing to fill in", () => {
    const record = { resourceType: "Condition", code: { text: "Asthma" } };
    expect(withNames(record as never, names)).toBe(record);
  });
});
