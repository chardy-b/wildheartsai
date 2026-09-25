# Record details and every record type: design and plan

**Status:** approved in chat on 2026-09-25. Builds on dashboard plan 04 (`docs/superpowers/plans/2026-09-23-dashboard-04-records-viewer.md`).

**Goal:** every record row expands in place to show everything the health system sent. The dashboard also covers every resource type Epic grants us, not just the first six.

## Decisions

| Area | Decision |
| --- | --- |
| Detail view | Expand in place: each row is a `<details>` element. Closed, it looks like today's row; open, it shows the detail. No JavaScript is needed to expand. No record IDs go in URLs. |
| What "everything" means | Readable, hand-labelled sections for that record type first, then a collapsed "All fields from {health system}" tree of every raw FHIR field. |
| New types | Reports (labs and imaging, `DiagnosticReport`), notes and documents (`DocumentReference`), procedures, vitals, social history, care team, care plans, goals, orders (`ServiceRequest`), pharmacy fills (`MedicationDispense`), devices, insurance (`Coverage`). |
| Dashboard | Dated items join the timeline. Every type has a category page. Summary chips show only categories with at least one record. |
| Imaging | Reports only. Epic's patient APIs don't serve images (DICOM). |
| Note text | Fetched when the person clicks "Show note", through a server action. The server checks the connection belongs to the signed-in user and that the attachment URL is within that connection's FHIR base, and returns plain text only: HTML and RTF are converted, so health-system markup is never rendered. |
| Visit notes | Notes whose `context.encounter` points at a visit are listed inside that visit's detail. This matches records already fetched, with no extra requests. |
| Storage | Still live fetch, nothing stored or logged. Each `RecordItem` carries its raw resource for rendering only. |

## Architecture

- **`src/lib/fhir/types.ts`**: adds types for the new resources (only the fields we read).
- **`src/lib/fhir/normalize.ts`**:
  - `RecordCategory` grows to 18 values.
  - `RecordItem` gains `resource: Resource` and `connectionId: string`.
  - A normalizer for each new type, keeping the existing title, date, detail and status contract.
- **`src/lib/fhir/describe.ts`**: `describeRecord(item) → { label: string; values: string[] }[]`. These are the readable sections per type, pure and tested.
- **`src/lib/fhir/fields.ts`**: `fieldTree(resource) → FieldNode[]`. Readable labels for keys (`effectiveDateTime` → "Effective date time"), arrays numbered, codings shown as "display (code)".
- **`src/lib/fhir/note-text.ts`**: `noteToText(contentType, body)` for HTML and RTF (plus plain text passing through), capped in length.
- **`src/lib/records.ts`**:
  - `RECORD_QUERIES` covers every type. Epic's required search parameters are confirmed in the sandbox.
  - `countByCategory` covers all categories.
  - The allowlist test lists every type.
- **`src/lib/records-notes.ts`** (server-only): `loadNoteText(userId, connectionId, attachmentUrl)` reuses the FHIR client's URL checks and size limit.
- **UI:**
  - `RecordList` rows become `<details>` elements containing a `RecordDetail` (readable sections, visit notes, `AllFields`).
  - `NoteText` is a small client component calling the `showNoteAction` server action.
  - `CATEGORIES` gains the new labels and slugs; the summary chips hide zeros.
- **Copy:** the connections page's "What we ask for" list and the privacy notice's "what we request" sentence both describe the full set.

## Error handling

- A search that fails for one type still marks that connection "unavailable" (existing behaviour), so other types and connections still show.
- A note that can't be loaded shows "We couldn't load this note just now" inline.
- Unknown or missing fields are simply absent from the readable sections. The raw tree still shows whatever arrived.

## Testing

- Unit tests for each new normalizer, each `describeRecord` branch, `fieldTree`, `noteToText` (HTML, RTF, plain text, cap), and the updated allowlist.
- `loadNoteText` tests with PGlite: it rejects another user's connection and URLs outside the connection's base, and returns text.
- A sandbox walkthrough as the Epic sample patient: every new type loads, or its search parameters get fixed; rows expand; a visit shows its notes; "Show note" loads text; the logs contain no record content.

## Tasks

1. Types, `RecordItem` fields, new normalizers and categories (TDD).
2. `describeRecord` and `fieldTree` (TDD).
3. `noteToText` and `loadNoteText`, plus the server action (TDD).
4. `RECORD_QUERIES` for every type, `countByCategory`, and the allowlist test (TDD); confirm parameters against the sandbox.
5. UI: expandable rows, `RecordDetail`, `AllFields`, `NoteText`, and chips without zeros.
6. Copy updates; full checks; sandbox walkthrough; PR.
