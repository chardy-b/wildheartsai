import { useState } from "react";
import { ALLERGY_PANEL, AUDIOGRAM, ferritinSamples, PATHOLOGY } from "./demo-data";

// Bundled generative illustration; no human subject or report-derived imaging.
export const MRI_VISUAL_SOURCE: { label: string; href?: string } = {
  label: "AI-generated illustration · 100% synthetic · not diagnostic",
};

type Measurement = { date: string; value: number };

/** SVG is visual only; every measurement, date and unit is repeated in the caption. */
function ComparisonChart({ label, samples, unit, ceiling, floor }: {
  label: string; samples: Measurement[]; unit: string; ceiling: number; floor?: number;
}) {
  const y = (value: number) => 154 - (value / ceiling) * 116;
  return (
    <figure className="hd-result-figure">
      <div className="hd-plot-heading"><strong>{label}</strong><span>{unit}</span></div>
      <svg className="hd-plot" viewBox="0 0 360 210" aria-hidden="true" focusable="false">
        {[0, ceiling / 2, ceiling].map((value) => (
          <g key={value}>
            <line x1="42" x2="342" y1={y(value)} y2={y(value)} className="hd-gridline" />
            <text x="32" y={y(value) + 4} textAnchor="end">{value}</text>
          </g>
        ))}
        {floor !== undefined && <>
          <line x1="42" x2="342" y1={y(floor)} y2={y(floor)} className="hd-reference" />
          <text x="48" y="22">Dashed: reference floor {floor}</text>
        </>}
        {samples.map((sample, i) => {
          const x = samples.length === 1 ? 192 : 120 + i * 150;
          return (
            <g key={sample.date}>
              <rect x={x - 26} y={y(sample.value)} width="52" height={154 - y(sample.value)} rx="4" className={i === 0 ? "hd-bar-earlier" : "hd-bar-later"} />
              <text x={x} y={y(sample.value) - 8} textAnchor="middle" className="hd-value-label">{sample.value}</text>
              <text x={x} y="180" textAnchor="middle">{sample.date.replace(" 2026", "")}</text>
              <text x={x} y="197" textAnchor="middle">2026</text>
            </g>
          );
        })}
      </svg>
      <figcaption className="hd-chart-receipt">
        {samples.map((sample) => <span key={sample.date}><span>{sample.date}</span><strong>{sample.value} {unit}</strong></span>)}
      </figcaption>
    </figure>
  );
}

export function PathologyVisual() {
  return <ComparisonChart label="Peak eosinophil count" samples={PATHOLOGY} unit="eosinophils/hpf" ceiling={50} />;
}

export function FerritinVisual({ confirmed }: { confirmed: boolean }) {
  return <>
    <ComparisonChart label={confirmed ? "Ferritin comparison" : "Earlier ferritin"} samples={ferritinSamples(confirmed)} unit="ng/mL" ceiling={30} floor={15} />
    <p className="hd-visual-note">Detail view: 0–30 ng/mL. Printed reference range: 15–150 ng/mL; dashed line marks its lower limit, not a treatment target. Review with your care team.</p>
  </>;
}

export function AudiogramVisual() {
  const x = (i: number) => 48 + i * 56;
  // dB HL increases downwards, following standard audiogram orientation.
  const y = (value: number) => 38 + ((value + 10) / 70) * 140;
  return (
    <figure className="hd-result-figure">
      <div className="hd-plot-heading"><strong>Air-conduction thresholds</strong><span>Synthetic</span></div>
      <p className="hd-visual-note">Right ○ · Left × · dB HL increases downward</p>
      <svg className="hd-plot" viewBox="0 0 360 232" aria-hidden="true" focusable="false">
        <text x="12" y="16">dB HL</text>
        {[-10, 0, 20, 40, 60].map((value) => <g key={value}>
          <line x1="48" x2="328" y1={y(value)} y2={y(value)} className="hd-gridline" />
          <text x="36" y={y(value) + 4} textAnchor="end">{value}</text>
        </g>)}
        {AUDIOGRAM.map((point, i) => <g key={point.hz}>
          <line x1={x(i)} x2={x(i)} y1="38" y2="178" className="hd-gridline" />
          <text x={x(i)} y="201" textAnchor="middle">{point.hz >= 1000 ? `${point.hz / 1000}k` : point.hz}</text>
        </g>)}
        <text x="188" y="224" textAnchor="middle">Frequency (Hz) · octave steps</text>
        {(["right", "left"] as const).map((ear) => <g key={ear} className={`hd-ear-${ear}`}>
          <polyline points={AUDIOGRAM.map((p, i) => `${x(i)},${y(p[ear])}`).join(" ")} fill="none" strokeWidth="2" />
          {AUDIOGRAM.map((p, i) => ear === "right"
            ? <circle key={p.hz} cx={x(i)} cy={y(p.right)} r="5" fill="#fffcf9" strokeWidth="2.5" />
            : <path key={p.hz} d={`M${x(i) - 5},${y(p.left) - 5}l10,10m-10,0l10,-10`} strokeWidth="2.5" />)}
        </g>)}
      </svg>
      <details className="hd-details">
        <summary>Threshold data · both ears</summary>
        <table className="hd-result-table">
          <caption>Synthetic air-conduction thresholds · 12 Nov 2026</caption>
          <thead><tr><th scope="col">Hz</th><th scope="col">Right ○ (dB HL)</th><th scope="col">Left × (dB HL)</th></tr></thead>
          <tbody>{AUDIOGRAM.map((p) => <tr key={p.hz}><th scope="row">{p.hz}</th><td>{p.right}</td><td>{p.left}</td></tr>)}</tbody>
        </table>
      </details>
      <figcaption className="hd-visual-note">Illustrative thresholds, not extracted from the sample report. No diagnostic interpretation.</figcaption>
    </figure>
  );
}

export function AllergyVisual() {
  return <>
    <p className="hd-visual-note">Synthetic skin-prick panel · 26 Aug 2026 · wheal diameter measured at 15 minutes</p>
    <table className="hd-result-table hd-allergy-table">
      <caption>Environmental allergens and test controls</caption>
      <thead><tr><th scope="col">Allergen / control</th><th scope="col">Wheal (mm)</th></tr></thead>
      <tbody>{ALLERGY_PANEL.map((row) => <tr key={row.name}>
        <th scope="row">{row.name}<small>{row.type}</small></th>
        <td><span className="hd-wheal"><span aria-hidden="true" className="hd-wheal-track"><i style={{ width: `${row.mm / 8 * 100}%` }} /></span><strong>{row.mm} mm</strong></span></td>
      </tr>)}</tbody>
    </table>
    <p className="hd-visual-note">Separate environmental-allergen testing, not the flushing evaluation. These sample measurements do not diagnose allergy or MCAS; MCAS remains unconfirmed.</p>
  </>;
}

export function MriVisual({ src }: { src: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <figure className="hd-mri-figure">
      <div className="hd-mri-viewer" data-expanded={expanded}>
        <div className="hd-mri-head"><strong>Brain MRI</strong><span>Example scan</span></div>
        {/* Plain img supports the same bundled asset and inline data URL in the offline review. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="AI-generated brain MRI illustration; not Alex’s scan and not diagnostic." width={720} height={720} decoding="async" />
        <button type="button" className="hd-mri-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Reduce example scan" : "Enlarge example scan"}</button>
      </div>
      <figcaption>
        <p>Example image only — separate from Alex’s sample report below.</p>
        <span className="hd-src">{MRI_VISUAL_SOURCE.href ? <a href={MRI_VISUAL_SOURCE.href} target="_blank" rel="noreferrer">{MRI_VISUAL_SOURCE.label}</a> : MRI_VISUAL_SOURCE.label}</span>
      </figcaption>
    </figure>
  );
}
