import { describe, expect, it } from "vitest";
import { publicFailureCode } from "./failures";

describe("public extraction failures", () => {
  it("keeps known diagnostics and replaces arbitrary content without coercion", () => {
    expect(publicFailureCode("pdf_page_limit")).toBe("pdf_page_limit");
    for (const value of [undefined, null, "synthetic private text", "parse_failed\nprivate", { toString: () => { throw new Error("must not coerce"); } }]) {
      expect(publicFailureCode(value)).toBe("processing_failed");
    }
  });
});
