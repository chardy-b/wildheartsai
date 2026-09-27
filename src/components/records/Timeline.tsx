import { yearOf } from "@/lib/fhir/format";
import type { RecordItem } from "@/lib/fhir/normalize";
import { groupVitals } from "@/lib/timeline-groups";
import { RecordRow, recordKey, VitalsRow } from "./RecordList";

// Records by year, newest first, with each day's vitals from one organization folded into one row.
export function Timeline({ items, related = items, tones = {} }: { items: RecordItem[]; related?: RecordItem[]; tones?: Record<string, number> }) {
  const years = new Map<string, RecordItem[]>();
  for (const item of items) {
    const year = yearOf(item.date);
    years.set(year, [...(years.get(year) ?? []), item]);
  }
  return (
    <div className="timeline">
      {[...years.entries()].map(([year, yearItems]) => (
        <section key={year} aria-labelledby={`year-${year}`}>
          <h2 id={`year-${year}`}>{year}</h2>
          <ul className="record-list">
            {groupVitals(yearItems).map((entry) =>
              entry.kind === "record" ? (
                <RecordRow key={recordKey(entry.item)} item={entry.item} related={related} showCategory tones={tones} />
              ) : (
                <VitalsRow key={entry.key} day={entry.day} source={entry.source} sourceId={entry.sourceId} items={entry.items} related={related} tones={tones} />
              ),
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}
