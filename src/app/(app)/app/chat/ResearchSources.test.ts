import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResearchExcerpt } from "./ResearchSources";

describe("saved research citations", () => {
  it("renders repository markup and executable links as plain text with saved provenance", () => {
    const markup = renderToStaticMarkup(React.createElement(ResearchExcerpt, {
      snapshotId: "a".repeat(64),
      passage: { sourceId: "b".repeat(64), title: "<script>unsafe()</script>", path: "studies/example.md", startLine: 12, endLine: 14,
        excerpt: '<img src=x onerror="unsafe()">\n[open](javascript:unsafe())', offset: 0, nextOffset: 20, totalChars: 100, truncated: true },
    }));
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<a ");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain("studies/example.md");
    expect(markup).toContain("Lines 12–14");
    expect(markup).toContain("a".repeat(64));
    expect(markup).toContain("saved excerpt");
  });
});
