import { describe, expect, it } from "vitest";
import { parseToolInput } from "./tools";

const targetId = "11111111-1111-4111-8111-111111111111";

describe("save_summary tool schema", () => {
  it("accepts owned target citations but rejects model-controlled metadata identifiers", () => {
    expect(
      parseToolInput("save_summary", {
        title: "Lab summary",
        text: "A short stored summary.",
        coverageState: "partial",
        evidence: [{ kind: "record", targetId }],
      }),
    ).toMatchObject({ evidence: [{ kind: "record", targetId }] });

    expect(() =>
      parseToolInput("save_summary", {
        title: "Lab summary",
        text: "A short stored summary.",
        coverageState: "partial",
        idempotencyKey: "patient-name-must-not-be-metadata",
        evidence: [{ id: targetId, kind: "record", targetId }],
      }),
    ).toThrow();
  });
});
