import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelReadinessNotice, ThinkingDisclosure } from "./HealthChat";
import type { ModelReadiness } from "./use-model-warmup";

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

describe("ModelReadinessNotice", () => {
  const onRetry = () => undefined;

  it("explains that questions can be sent while the model loads", () => {
    const readiness: ModelReadiness = {
      status: "queued",
      retryAt: null,
      readyUntil: null,
      checking: true,
      lastConfirmedAt: null,
      message: null,
    };
    const html = renderToStaticMarkup(createElement(ModelReadinessNotice, { readiness, onRetry }));

    expect(html).toContain("Loading model");
    expect(html).toContain("You can send a question while it loads.");
  });

  it("labels readiness as the last confirmation and warns it can expire", () => {
    const readiness: ModelReadiness = {
      status: "ready",
      retryAt: null,
      readyUntil: "2026-10-11T12:05:00Z",
      checking: false,
      lastConfirmedAt: Date.parse("2026-10-11T12:00:00Z"),
      message: null,
    };
    const html = renderToStaticMarkup(createElement(ModelReadinessNotice, { readiness, onRetry }));

    expect(html).toContain("Ready");
    expect(html).toContain("Last confirmed at");
    expect(html).toContain("It may unload later.");
  });

  it("offers manual retry after warmup failure", () => {
    const readiness: ModelReadiness = {
      status: "failed",
      retryAt: null,
      readyUntil: null,
      checking: false,
      lastConfirmedAt: null,
      message: "The model could not be loaded. You can try again.",
    };
    const html = renderToStaticMarkup(createElement(ModelReadinessNotice, { readiness, onRetry }));

    expect(html).toContain("Model warmup failed");
    expect(html).toContain("Try loading again");
  });
});
