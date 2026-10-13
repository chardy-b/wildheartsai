import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatAnswer } from "./ChatPresentation";
import { RecordSource } from "./RecordSources";

describe("FHIR record references", () => {
  it("links only identifiers backed by the answer's saved receipts", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const foreign = "22222222-2222-4222-8222-222222222222";
    const html = renderToStaticMarkup(React.createElement(ChatAnswer, { text: `Result: **${id}**; unverified ${foreign}`, references: [{ id, label: "Record 1", target: `source-run-${id}` }] }));
    expect(html).toContain(`href="#source-run-${id}"`);
    expect(html).toContain("Record 1</a>");
    expect(html).not.toContain(`href="#source-run-${foreign}"`);
    expect(html).toContain(foreign);
  });

  it("shows escaped FHIR details, provenance and the version warning", () => {
    const html = renderToStaticMarkup(React.createElement(RecordSource, { index: 0, runId: "run", source: {
      id: "source", kind: "record", title: "Synthetic potassium", detail: "4 mmol/L", date: "2026-10-11T12:00:00Z", organization: "Synthetic clinic",
      reference: "Observation/synthetic", version: "3", earlierVersion: true,
      sections: [{ label: "Result", values: ['<script>unsafe()</script>'] }], truncated: false,
    } }));
    expect(html).toContain("Observation/synthetic");
    expect(html).toContain("Source version");
    expect(html).toContain("earlier saved version");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
