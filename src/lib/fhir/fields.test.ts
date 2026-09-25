import { describe, expect, it } from "vitest";
import { fieldLabel, fieldTree } from "./fields";

describe("fieldLabel", () => {
  it("turns FHIR keys into sentence-case labels", () => {
    expect(fieldLabel("effectiveDateTime")).toBe("Effective date time");
    expect(fieldLabel("valueQuantity")).toBe("Value quantity");
    expect(fieldLabel("id")).toBe("ID");
    expect(fieldLabel("resourceType")).toBe("Resource type");
  });
});

describe("fieldTree", () => {
  it("lists every field, nesting objects and numbering list items", () => {
    expect(
      fieldTree({
        resourceType: "Observation",
        status: "final",
        valueQuantity: { value: 6.1, unit: "%" },
        interpretation: [{ text: "High" }, { text: "Abnormal" }],
        meta: { versionId: "1" },
      }),
    ).toEqual([
      { label: "Resource type", value: "Observation" },
      { label: "Status", value: "final" },
      { label: "Value quantity", children: [{ label: "Value", value: "6.1" }, { label: "Unit", value: "%" }] },
      {
        label: "Interpretation",
        children: [
          { label: "1", children: [{ label: "Text", value: "High" }] },
          { label: "2", children: [{ label: "Text", value: "Abnormal" }] },
        ],
      },
      { label: "Meta", children: [{ label: "Version ID", value: "1" }] },
    ]);
  });

  it("shows a single-item list without numbering, and skips empty values", () => {
    expect(fieldTree({ note: [{ text: "Fasting" }], empty: [], blank: "", nothing: null })).toEqual([
      { label: "Note", children: [{ label: "Text", value: "Fasting" }] },
    ]);
  });

  it("stops at a size limit so an unusually large record can't flood the page", () => {
    const big = { items: Array.from({ length: 2000 }, (_, i) => ({ n: i })) };
    const count = (nodes: ReturnType<typeof fieldTree>): number => nodes.reduce((n, node) => n + 1 + count(node.children ?? []), 0);
    const tree = fieldTree(big);
    expect(count(tree)).toBeLessThanOrEqual(401);
    expect(JSON.stringify(tree)).toContain("More fields not shown");
  });
});
