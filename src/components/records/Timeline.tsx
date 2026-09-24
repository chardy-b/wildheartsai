import { yearOf } from "@/lib/fhir/format";
import type { RecordItem } from "@/lib/fhir/normalize";
import { RecordList } from "./RecordList";

export function Timeline({ items }: { items: RecordItem[] }) {
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
          <RecordList items={yearItems} showCategory />
        </section>
      ))}
    </div>
  );
}
