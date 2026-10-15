import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentMarkdown } from "./DocumentMarkdown";

describe("untrusted document markdown", () => {
  it("renders headings and measurement tables without HTML or remote requests", () => {
    const html = renderToStaticMarkup(createElement(DocumentMarkdown, { text: "# Results\n\n| Test | Value |\n| --- | --- |\n| Synthetic | 42 |\n\n![tracking](https://example.com/patient.png)\n\n[external](https://example.com/private)\n\n<script>alert('unsafe')</script>" }));
    expect(html).toContain("<h3>Results</h3>");
    expect(html).toContain("<table>"); expect(html).toContain("Synthetic");
    expect(html).not.toMatch(/<(img|script|a)\b/);
    expect(html).not.toContain("https://example.com");
  });
});
