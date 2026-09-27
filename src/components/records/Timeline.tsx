import { yearOf } from "@/lib/fhir/format";
import type { RecordItem } from "@/lib/fhir/normalize";
import { groupVitals, splitUpcoming } from "@/lib/timeline-groups";
import { RecordRow, recordKey, VitalsRow } from "./RecordList";

// Upcoming records (appointments) first, soonest first; then records by year, newest first, with
// each day's vitals from one organization folded into one row.
export function Timeline({
  items,
  related = items,
  tones = {},
  now = new Date(),
}: {
  items: RecordItem[];
  related?: RecordItem[];
  tones?: Record<string, number>;
  now?: Date;
}) {
  const { upcoming, past } = splitUpcoming(items, now);
  const years = new Map<string, RecordItem[]>();
  for (const item of past) {
    const year = yearOf(item.date);
    years.set(year, [...(years.get(year) ?? []), item]);
  }
  return (
    <div className="timeline">
      {upcoming.length ? (
        <section aria-labelledby="year-upcoming">
          <h2 id="year-upcoming">Upcoming</h2>
          <ul className="record-list">
            {upcoming.map((item) => (
              <RecordRow key={recordKey(item)} item={item} related={related} showCategory tones={tones} />
            ))}
          </ul>
        </section>
      ) : null}
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
