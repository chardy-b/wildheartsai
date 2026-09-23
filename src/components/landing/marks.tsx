// The heart is two 5px circles over a point on a 24px grid. It is used as a
// shape only in the logo and the favicon (src/app/icon.svg).
export const HEART_PATH =
  "M12 21L4.27 12.33A5 5 0 1 1 12 6A5 5 0 1 1 19.73 12.33Z";

export function HeartMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d={HEART_PATH} fill="var(--rasp)" />
    </svg>
  );
}

// The companion's face: two dots, never joined by a line (that would be
// Baymax's face). It appears only where the product acts.
export function FaceMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 12" className={className} aria-hidden="true">
      <g className="face-eyes">
        <circle cx="5" cy="6" r="2.6" />
        <circle cx="19" cy="6" r="2.6" />
      </g>
    </svg>
  );
}
