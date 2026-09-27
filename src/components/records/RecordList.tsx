import { labelFor } from "@/lib/fhir/categories";
import { formatRecordDate } from "@/lib/fhir/format";
import type { RecordItem } from "@/lib/fhir/normalize";
import { vitalsSummary } from "@/lib/timeline-groups";
import { RecordDetail } from "./RecordDetail";

type Tones = Record<string, number>;

function SourceTag({ source, sourceId, tones }: { source: string; sourceId?: string; tones: Tones }) {
  return (
    <span className={sourceId !== undefined && tones[sourceId] !== undefined ? `source-tag tone-${tones[sourceId]}` : undefined}>
      From {source}
    </span>
  );
}

export function recordKey(item: RecordItem): string {
  return item.sourceId ? `${item.sourceId}|${item.key}` : item.key;
}

// One record; expands in place to show everything the health system sent.
export function RecordRow({ item, related, showCategory, tones }: { item: RecordItem; related: RecordItem[]; showCategory: boolean; tones: Tones }) {
  return (
    <li>
      <details className="record">
        <summary>
          <span className="record-dot" aria-hidden="true" />
          <div>
            <h3>{item.title}</h3>
            {item.detail ? <p className="record-detail">{item.detail}</p> : null}
            <div className="record-meta">
              {showCategory ? <span>{labelFor(item.category)}</span> : null}
              {item.status ? <span>{item.category === "lab" || item.category === "vital" ? `Marked ${item.status}` : item.status}</span> : null}
              {item.history?.length ? <span>Amended</span> : null}
              <SourceTag source={item.source} sourceId={item.sourceId} tones={tones} />
            </div>
          </div>
          <time className="record-date" dateTime={item.date ?? undefined}>
            {formatRecordDate(item.date)}
          </time>
        </summary>
        <RecordDetail item={item} related={related} />
      </details>
    </li>
  );
}

// A day's vital signs from one organization as one row; expands to each measurement.
export function VitalsRow({
  day,
  source,
  sourceId,
  items,
  related,
  tones,
}: {
  day: string;
  source: string;
  sourceId?: string;
  items: RecordItem[];
  related: RecordItem[];
  tones: Tones;
}) {
  return (
    <li>
      <details className="record">
        <summary>
          <span className="record-dot" aria-hidden="true" />
          <div>
            <h3>Vitals</h3>
            <p className="record-detail">{vitalsSummary(items)}</p>
            <div className="record-meta">
              <span>{items.length} measurements</span>
              <SourceTag source={source} sourceId={sourceId} tones={tones} />
            </div>
          </div>
          <time className="record-date" dateTime={day}>
            {formatRecordDate(day)}
          </time>
        </summary>
        <div className="record-body">
          <RecordList items={items} related={related} tones={tones} />
        </div>
      </details>
    </li>
  );
}

// `related` is the wider set used to find a visit's notes (defaults to `items`).
// `tones` gives each organization's tag its own color, by source id.
export function RecordList({
  items,
  related = items,
  showCategory = false,
  tones = {},
}: {
  items: RecordItem[];
  related?: RecordItem[];
  showCategory?: boolean;
  tones?: Tones;
}) {
  return (
    <ul className="record-list">
      {items.map((item) => (
        <RecordRow key={recordKey(item)} item={item} related={related} showCategory={showCategory} tones={tones} />
      ))}
    </ul>
  );
}
