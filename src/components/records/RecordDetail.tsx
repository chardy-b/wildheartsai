import { describeResource } from "@/lib/fhir/describe";
import { fieldTree, type FieldNode } from "@/lib/fhir/fields";
import { formatRecordDate } from "@/lib/fhir/format";
import { noteAttachment, notesForVisit } from "@/lib/fhir/links";
import type { RecordItem } from "@/lib/fhir/normalize";
import { NoteText } from "./NoteText";

function FieldList({ nodes }: { nodes: FieldNode[] }) {
  return (
    <dl className="field-tree">
      {nodes.map((node, i) => (
        <div key={`${node.label}-${i}`}>
          <dt>{node.label}</dt>
          <dd>{node.children ? <FieldList nodes={node.children} /> : node.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Note({ note }: { note: RecordItem }) {
  const attachment = noteAttachment(note.resource);
  return attachment ? (
    <NoteText connectionId={note.connectionId} attachmentUrl={attachment.url} />
  ) : (
    <p className="record-note">This document isn&apos;t text we can show here. You can open it in MyChart.</p>
  );
}

// The expanded part of a record row: readable sections first, then every field as sent.
export function RecordDetail({ item, related }: { item: RecordItem; related: RecordItem[] }) {
  const sections = describeResource(item.resource);
  const visitNotes = item.category === "visit" ? notesForVisit(item, related) : [];
  return (
    <div className="record-body">
      {sections.length ? (
        <dl className="record-sections">
          {sections.map((section) => (
            <div key={section.label}>
              <dt>{section.label}</dt>
              <dd>{section.values.length === 1 ? section.values[0] : <ul>{section.values.map((v) => <li key={v}>{v}</li>)}</ul>}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {item.category === "note" ? <Note note={item} /> : null}

      {visitNotes.length ? (
        <div className="visit-notes">
          <h4>Notes from this visit</h4>
          {visitNotes.map((note) => (
            <div className="visit-note" key={note.key}>
              <p>
                <strong>{note.title}</strong> · {formatRecordDate(note.date)}
                {note.detail ? ` · ${note.detail}` : ""}
              </p>
              <Note note={note} />
            </div>
          ))}
        </div>
      ) : null}

      <details className="all-fields">
        <summary>All fields from {item.source}</summary>
        <FieldList nodes={fieldTree(item.resource as Record<string, unknown>)} />
      </details>
    </div>
  );
}
