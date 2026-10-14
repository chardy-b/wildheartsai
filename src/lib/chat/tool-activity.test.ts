import { describe, expect, it } from "vitest";
import { describeToolActivity, summarizeToolActivity } from "./tool-activity";
import { protocolEventSchema } from "../chat-web/protocol";

describe("tool activity metadata", () => {
  it("describes the actual filters without exposing opaque source identifiers", () => {
    const label = describeToolActivity("find_records", { query: "LDL", categories: ["lab"], from: "2024-01-01", to: "2026-01-01", sourceIds: ["private-source-id"] });
    expect(label).toBe("Searching lab results for “LDL” from 2024-01-01 to before 2026-01-01 across 1 selected source");
    expect(describeToolActivity("read_records", { recordIds: ["secret-a", "secret-b"], includeDetails: true })).toBe("Reading 2 selected records in detail");
  });

  it("reports returned counts without claiming an exhaustive search", () => {
    expect(summarizeToolActivity("find_records", { output: { records: [{}, {}], truncated: true } })).toEqual({ outcome: "2 results returned · Search limited" });
    expect(summarizeToolActivity("find_records", { output: { records: [], truncated: true } })).toEqual({ outcome: "No matching results · Search limited" });
    expect(summarizeToolActivity("find_records", { status: "failed" })).toEqual({});
    expect(summarizeToolActivity("find_records", { output: {} })).toEqual({});
  });

  it("uses returned record titles and actual read count, not the requested count", () => {
    expect(summarizeToolActivity("read_records", { output: { items: [{ citation: { id: "private" }, summary: { title: "Synthetic lab" } }] } })).toEqual({ description: "Reading records: “Synthetic lab”", outcome: "1 record read" });
    expect(summarizeToolActivity("read_stored_note", { output: { available: false } })).toEqual({ outcome: "Note unavailable" });
    expect(summarizeToolActivity("read_stored_note", { output: { available: true, text: "private note", truncated: true } })).toEqual({ outcome: "1 note read · Excerpt only" });
  });

  it("supports coverage, summaries, trends and research", () => {
    expect(summarizeToolActivity("get_data_coverage", { output: { sources: [{}], categories: [{ count: 4 }, { count: 2 }] } }).outcome).toBe("6 records across 1 source");
    expect(summarizeToolActivity("find_saved_summaries", { output: { items: [] } }).outcome).toBe("No matching summaries");
    expect(summarizeToolActivity("calculate_lab_trend", { output: { ok: true, test: "Synthetic lab", points: [{}, {}] } })).toEqual({ description: "Comparing results for “Synthetic lab”", outcome: "2 lab results compared" });
    expect(summarizeToolActivity("search_research", { output: { hits: [{}], truncated: false } }).outcome).toBe("1 result returned");
    expect(summarizeToolActivity("read_research", { output: { title: "Synthetic reference", excerpt: "text", truncated: true } }).outcome).toBe("1 research passage read · Excerpt only");
  });

  it("bounds display text and validates the expanded event protocol", () => {
    const description = describeToolActivity("find_records", { query: "x".repeat(1000), categories: ["lab"] });
    expect(description.length).toBeLessThanOrEqual(600);
    const base = { eventId: "00000000-0000-4000-8000-000000000001", sequence: 1 };
    expect(protocolEventSchema.safeParse({ ...base, type: "tool.started", data: { toolCallId: "call-one", tool: "find_records", description } }).success).toBe(true);
    expect(protocolEventSchema.safeParse({ ...base, type: "tool.completed", data: { toolCallId: "call-one", status: "completed", outcome: "1 result returned" } }).success).toBe(true);
  });
});
