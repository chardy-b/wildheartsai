import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentMarkdown } from "./DocumentMarkdown";

describe("untrusted document markdown", () => {
  it("structures plain OCR sections, fields, bullets and aligned columns without changing values", () => {
    const text = "LAB RESULTS\nCollected: 2026-10-20\nStatus: Final\nTest  Value  Unit\nGlucose  5.2  mmol/L\nFOLLOW UP:\n• Review results\n• Repeat in 3 months\nPreserve this ordinary sentence.";
    const html = renderToStaticMarkup(createElement(DocumentMarkdown, { text, structure: true }));
    expect(html).toContain("<h3>LAB RESULTS</h3>");
    expect(html).toContain("<strong>Collected:</strong> 2026-10-20");
    expect(html).toContain("<strong>Status:</strong> Final");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>Glucose</td>");
    expect(html).toContain("<td>5.2</td>");
    expect(html).toContain("<td>mmol/L</td>");
    expect(html).toContain("<li>Review results</li>");
    expect(html).toContain("<li>Repeat in 3 months</li>");
    expect(html).toContain("<p>Preserve this ordinary sentence.</p>");
  });

  it("keeps existing Markdown, code and redaction markers intact", () => {
    const text = "## Summary\n\n**Status:** Final\n\n- Review results\n\n```text\nRESULTS\nName: [REDACTED]\n```\n\nPatient: [REDACTED]\n\n| Test | Value |\n| --- | --- |\n| A | 42 |";
    const html = renderToStaticMarkup(createElement(DocumentMarkdown, { text, structure: true }));
    expect(html).toContain("<h3>Summary</h3>");
    expect(html).toContain("<strong>Status:</strong> Final");
    expect(html).toContain("<li>Review results</li>");
    expect(html).toContain("<code class=\"language-text\">RESULTS\nName: [REDACTED]\n</code>");
    expect(html).toContain("<strong>Patient:</strong> [REDACTED]");
    expect(html).toContain("<th>Test</th>");
    expect(html).not.toContain("Column 1");
  });

  it("does not invent columns for inconsistent spacing or turn values into headings", () => {
    const text = "WBC  5.2\nPlatelets  200  K/uL\nHGB 13.5 g/dL\n[REDACTED]";
    const html = renderToStaticMarkup(createElement(DocumentMarkdown, { text, structure: true }));
    expect(html).not.toMatch(/<(table|h3)\b/);
    expect(html).toContain(text);
  });

  it("shows an explicit empty result", () => {
    expect(renderToStaticMarkup(createElement(DocumentMarkdown, { text: " \n\t", structure: true }))).toContain("No text was extracted from this page.");
  });

  it("renders headings and measurement tables without HTML or remote requests", () => {
    const html = renderToStaticMarkup(createElement(DocumentMarkdown, { structure: true, text: "# Results\n\n| Test | Value |\n| --- | --- |\n| Synthetic | 42 |\n\n![tracking](https://example.com/patient.png)\n\n[external](https://example.com/private)\n\n<script>alert('unsafe')</script>" }));
    expect(html).toContain("<h3>Results</h3>");
    expect(html).toContain("<table>"); expect(html).toContain("Synthetic");
    expect(html).not.toMatch(/<(img|script|a)\b/);
    expect(html).not.toContain("https://example.com");
  });
});
