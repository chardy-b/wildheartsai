"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { FaceMark } from "./marks";

type Phase = "scattered" | "poured" | "done" | "fading" | "snap";

const RECORDS = [
  { label: "Cardiology", meta: "2019", x: 22, y: 18, r: -8 },
  { label: "ER visit", meta: "2022", x: 40, y: 27, r: 7 },
  { label: "Rheumatology", meta: "4 visits", x: 20, y: 35, r: 4 },
  { label: "Labs", meta: "14 results", x: 40, y: 43, r: -6 },
  { label: "Imaging", meta: "2 studies", x: 27, y: 51, r: 3 },
  { label: "Primary care", meta: "since 2016", x: 34, y: 24, r: -2 },
];

const STAGGER_MS = 380;

// How long each phase lasts before moving to the next one.
const NEXT: Record<Phase, [Phase, number]> = {
  scattered: ["poured", 900],
  poured: ["done", RECORDS.length * STAGGER_MS + 900],
  done: ["fading", 4200],
  fading: ["snap", 450],
  snap: ["scattered", 60],
};

export function FigureEight() {
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("scattered");
  const [active, setActive] = useState(false);

  // Only run the loop while the hourglass is on screen, the tab is visible,
  // and the visitor has not asked for reduced motion.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let onScreen = false;
    const sync = () =>
      setActive(onScreen && !document.hidden && !motion.matches);

    const observer = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      sync();
    });
    observer.observe(el);
    document.addEventListener("visibilitychange", sync);
    motion.addEventListener("change", sync);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
      motion.removeEventListener("change", sync);
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const [next, delay] = NEXT[phase];
    const timer = window.setTimeout(() => setPhase(next), delay);
    return () => window.clearTimeout(timer);
  }, [active, phase]);

  return (
    <div className="eight" data-phase={phase} ref={ref} aria-hidden="true">
      <div className="lobe lobe-top" />
      <div className="lobe lobe-bottom" />
      <span className="lobe-label">Every clinic</span>
      <FaceMark className="eight-face" />
      {RECORDS.map((record, i) => (
        <div
          key={record.label}
          className="record"
          style={
            {
              "--i": i,
              "--tx": `${record.x}cqw`,
              "--ty": `${record.y}cqw`,
              "--r": `${record.r}deg`,
            } as CSSProperties
          }
        >
          <span className="record-dot" />
          {record.label}
          <span className="record-meta">{record.meta}</span>
        </div>
      ))}
    </div>
  );
}
