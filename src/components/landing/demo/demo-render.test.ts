import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { A1C_QUESTION, A1C_SAMPLES, NEXT_VISIT, briefFor, briefText } from "./demo-data";
import { initialState, reducer } from "./demo-state";
import { BriefWidget, HoloDemo, ResultWidget } from "./HoloDemo";
import { A1cVisual } from "./result-visuals";

const go = () => {};
const hRef = () => () => {};
const render = renderToStaticMarkup;

function result(added = false, id = "a1c") {
  return render(createElement(ResultWidget, {
    id, state: { ...initialState, a1cQuestionAdded: added }, go, hRef,
    mriImageSrc: "/demo/mri-phantom.webp", onAddA1cQuestion: go,
  }));
}

describe("A1C result and visit brief rendering", () => {
  it("offers A1C in the opening choices without replacing existing flows", () => {
    const html = render(createElement(HoloDemo));
    expect(html).toContain('data-choice="result" data-arg="a1c"');
    expect(html).toContain("Is my A1C getting worse?");
    for (const kind of ["prep", "meds", "finder", "connect", "summary"]) expect(html).toContain(`data-choice="${kind}"`);
    expect(html).toContain('class="hd-pill">Demo</span>');
  });

  it("has the exact three dated percentages and source types outside decorative SVG", () => {
    const html = render(createElement(A1cVisual));
    const receipt = html.split("<figcaption")[1];
    for (const sample of A1C_SAMPLES) {
      expect(receipt).toContain(`${sample.type} · ${sample.date}`);
      expect(receipt).toContain(`${sample.value}%`);
    }
    expect(html).toContain('aria-hidden="true" focusable="false"');
    expect(html.match(/<circle /g)).toHaveLength(3);
    expect(html).toContain("Synthetic");
  });

  it("keeps sources usable before adding and shows feedback plus the specific next brief afterward", () => {
    const before = result();
    expect(before).toContain("It’s gone up a little at each check, across two clinics");
    expect(before).toContain("28 Nov 2026");
    expect(before).not.toContain("Tuesday");
    expect(before).toContain("<summary>Open sources</summary>");
    for (const sample of A1C_SAMPLES) expect(before).toContain(sample.source.what);
    expect(before).toContain('aria-pressed="false">Add to questions');
    expect(before).not.toContain('data-flow="a1c-brief"');
    const after = result(true);
    expect(after).toContain('aria-pressed="true">Added to questions');
    expect(after).toContain('data-flow="a1c-brief"');
    expect(after).toContain("Open GI brief · 28 Nov 2026");
    expect(after).toContain("Added to your 28 Nov 2026 GI visit questions.");
  });

  it("re-renders the same next-visit brief with the sourced question and export actions", () => {
    const brief = (state: typeof initialState) => render(createElement(BriefWidget, { id: NEXT_VISIT.id, state, go, hRef }));
    expect(brief(initialState)).not.toContain(A1C_QUESTION);
    const state = reducer(initialState, { type: "addA1cQuestion" });
    const html = brief(state);
    expect(html.split(A1C_QUESTION)).toHaveLength(2);
    expect(html).toContain("Juniper Primary Care · Mar 2024");
    expect(html).toContain("Maple Endocrinology · Oct 2024");
    expect(html).toContain("Juniper Primary Care · Jun 2025");
    expect(html).toContain("Copy brief");
    expect(html).toContain("Download .txt");
    expect(briefText(briefFor(NEXT_VISIT.id, { added: false, imported: false, a1cQuestionAdded: true }))).toContain(A1C_QUESTION);
    expect(brief(initialState)).not.toContain(A1C_QUESTION);
  });

  it("preserves the existing independent allergy result", () => {
    const html = result(false, "allergy");
    for (const text of ["Skin-prick panel", "Histamine", "Saline", "MCAS remains unconfirmed"]) expect(html).toContain(text);
    expect(html).not.toContain("A1C trend");
  });
});
