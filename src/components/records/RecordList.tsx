import { labelFor } from "@/lib/fhir/categories";
import { formatRecordDate } from "@/lib/fhir/format";
import type { RecordItem } from "@/lib/fhir/normalize";
import { RecordDetail } from "./RecordDetail";

// Each row expands in place to show everything the health system sent.
// `related` is the wider set used to find a visit's notes (defaults to `items`).
export function RecordList({ items, related = items, showCategory = false }: { items: RecordItem[]; related?: RecordItem[]; showCategory?: boolean }) {
  return (
    <ul className="record-list">
      {items.map((item) => (
        <li key={item.key}>
          <details className="record">
            <summary>
              <span className="record-dot" aria-hidden="true" />
              <div>
                <h3>{item.title}</h3>
                {item.detail ? <p className="record-detail">{item.detail}</p> : null}
                <div className="record-meta">
                  {showCategory ? <span>{labelFor(item.category)}</span> : null}
                  {item.status ? <span>{item.category === "lab" || item.category === "vital" ? `Marked ${item.status}` : item.status}</span> : null}
                  <span>From {item.source}</span>
                </div>
              </div>
              <time className="record-date" dateTime={item.date ?? undefined}>
                {formatRecordDate(item.date)}
              </time>
            </summary>
            <RecordDetail item={item} related={related} />
          </details>
        </li>
      ))}
    </ul>
  );
}
