import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AllergyVisual, AudiogramVisual, FerritinVisual, MriVisual, PathologyVisual } from "./result-visuals";

const render = renderToStaticMarkup;

describe("demo result visuals", () => {
  it("keeps unconfirmed ferritin out of the graph and its accessible receipt", () => {
    const before = render(<FerritinVisual confirmed={false} />);
    expect(before).toContain("22 ng/mL");
    expect(before).not.toContain("14 ng/mL");
    expect(before).not.toContain("18 Nov");
    const after = render(<FerritinVisual confirmed />);
    expect(after).toContain("14 ng/mL");
    expect(after).toContain("18 Nov 2026");
    expect(after).toContain("15–150 ng/mL");
    expect(after).toContain("not a treatment target");
  });

  it("provides dated pathology values outside the decorative SVG", () => {
    const html = render(<PathologyVisual />);
    expect(html).toContain("42 eosinophils/hpf");
    expect(html).toContain("8 eosinophils/hpf");
    expect(html).toContain("27 Jun 2026");
    expect(html).toContain("27 Oct 2026");
    expect(html).toContain('aria-hidden="true"');
  });

  it("provides both ears as table data and identifies synthetic thresholds", () => {
    const html = render(<AudiogramVisual />);
    for (const hz of [250, 500, 1000, 2000, 4000, 8000]) expect(html).toContain(`>${hz}</th>`);
    expect(html).toContain("Right ○ (dB HL)");
    expect(html).toContain("Left × (dB HL)");
    expect(html).toContain("increases downward");
    expect(html).toContain("not extracted from the sample report");
  });

  it("names skin-prick controls without inferring a diagnosis", () => {
    const html = render(<AllergyVisual />);
    for (const text of ["Histamine", "Positive control", "Saline", "Negative control", "Wheal (mm)", "MCAS remains unconfirmed"]) expect(html).toContain(text);
  });

  it("uses portable image URLs and identifies the generative illustration", () => {
    const html = render(<MriVisual src="data:image/webp;base64,example" />);
    expect(html).toContain('src="data:image/webp;base64,example"');
    expect(html).toContain('width="720" height="720"');
    expect(html).toContain("100% synthetic");
    expect(html).toContain("not Alex’s scan and not diagnostic");
    expect(html).toContain('aria-expanded="false"');
  });
});
