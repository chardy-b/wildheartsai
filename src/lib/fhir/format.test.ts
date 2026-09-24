import { describe, expect, it } from "vitest";
import { formatRecordDate, yearOf } from "./format";

describe("formatRecordDate", () => {
  it.each([
    ["2024-03-14", "Mar 14, 2024"],
    ["2024-03-14T23:30:00Z", "Mar 14, 2024"],
    ["2024-03", "Mar 2024"],
    ["2024", "2024"],
    [null, "Date not recorded"],
    ["not a date", "Date not recorded"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatRecordDate(value)).toBe(expected);
  });
});

describe("yearOf", () => {
  it("returns the year or Undated", () => {
    expect(yearOf("2023-11-02")).toBe("2023");
    expect(yearOf(null)).toBe("Undated");
  });
});
