import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThinkingDisclosure } from "./HealthChat";

describe("ThinkingDisclosure", () => {
  it("renders model working notes as escaped text in a collapsed disclosure", () => {
    const html = renderToStaticMarkup(createElement(ThinkingDisclosure, {
      text: '<script>alert("private")</script>',
      truncated: true,
    }));

    expect(html).toContain("<details");
    expect(html).toContain("<summary>Thinking</summary>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Only the beginning");
  });
});
