# Dashboard 04: Records Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard shows a person's conditions, medications, allergies, lab results, immunizations and visits from every connected Epic health system: as a summary and a timeline on `/app`, and as one list per category.

**Architecture:** Live fetch, nothing stored. On each request, server code decrypts each connection, gets a fresh access token (plan 03), and runs six FHIR searches per connection in parallel through a small paging client. Normalizers turn each FHIR resource into a flat `RecordItem` tagged with its source organization. An aggregator merges everything, sorts newest first, and reports per-connection problems (needs reconnect / unreachable) without failing the whole page. Pages are server components; no FHIR data is sent to client components beyond what is rendered.

**Tech Stack:** FHIR R4 JSON over `fetch`, TypeScript types for the fields we read, Next.js 16 server components with `loading.tsx`, Vitest.

**Spec:** `docs/superpowers/plans/2026-09-23-dashboard-roadmap.md`, `docs/creative-direction.md`. Requires plans 01–03 merged.

## Global Constraints

- Everything in plans 01 and 03's Global Constraints applies.
- Records are **never** written to the database, logs, analytics or URLs. Logging is limited to `[records] <ResourceType> failed <status>`.
- FHIR paging follows `next` links only on the connection's own origin, up to 5 pages per search.
- Show records as recorded. The UI never interprets, scores or reassures ("normal", "nothing to worry about"). It may show the health system's own interpretation text (for example "High") labelled as theirs.
- Every item shows which health system it came from.
- Dates from FHIR can be partial (`2024`, `2024-03`) and are formatted in UTC so they don't shift a day.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/fhir/types.ts` | The FHIR R4 fields we read |
| `src/lib/fhir/client.ts` | `fhirSearch()` with auth header, paging and origin check |
| `src/lib/fhir/normalize.ts` | `RecordItem`, one normalizer per resource type |
| `src/lib/fhir/categories.ts` | Category labels and URL slugs |
| `src/lib/fhir/format.ts` | Date formatting and year grouping |
| `src/lib/records.ts` | `RECORD_QUERIES`, `gatherRecords()`, `countByCategory()` |
| `src/lib/records-server.ts` | Server-only `loadRecordsFor(userId)` wiring |
| `src/components/records/*` | `RecordList`, `Timeline`, `ProblemNotices`, `records.css` |
| `src/app/(app)/app/page.tsx`, `loading.tsx` | Dashboard home |
| `src/app/(app)/app/records/[category]/page.tsx` | One category |

---

### Task 1: FHIR search client

**Files:**
- Create: `src/lib/fhir/types.ts`, `src/lib/fhir/client.ts`, `src/lib/fhir/client.test.ts`

**Interfaces:**
- Consumes: `EpicError`, `ReconnectRequiredError` (plan 03).
- Produces: FHIR types (`Coding`, `CodeableConcept`, `Reference`, `Resource`, `Bundle`, `Condition`, `MedicationRequest`, `AllergyIntolerance`, `Observation`, `Immunization`, `Encounter`); `fhirSearch<T extends Resource>(input: { baseUrl: string; path: string; resourceType: T["resourceType"]; accessToken: string; fetchImpl?: typeof fetch; maxPages?: number }): Promise<T[]>`.

- [ ] **Step 1: Create `src/lib/fhir/types.ts`**

```ts
// Only the FHIR R4 fields Wild Hearts reads. Everything is optional because
// health systems populate resources differently.
export type Coding = { system?: string; code?: string; display?: string };
export type CodeableConcept = { text?: string; coding?: Coding[] };
export type Reference = { reference?: string; display?: string };
export type Quantity = { value?: number; unit?: string };

export type Resource = { resourceType: string; id?: string };

export type Bundle = {
  resourceType: "Bundle";
  link?: { relation: string; url: string }[];
  entry?: { resource?: Resource }[];
};

export type Condition = Resource & {
  resourceType: "Condition";
  code?: CodeableConcept;
  clinicalStatus?: CodeableConcept;
  onsetDateTime?: string;
  recordedDate?: string;
};

export type MedicationRequest = Resource & {
  resourceType: "MedicationRequest";
  status?: string;
  medicationCodeableConcept?: CodeableConcept;
  medicationReference?: Reference;
  authoredOn?: string;
  dosageInstruction?: { text?: string }[];
};

export type AllergyIntolerance = Resource & {
  resourceType: "AllergyIntolerance";
  code?: CodeableConcept;
  clinicalStatus?: CodeableConcept;
  recordedDate?: string;
  reaction?: { manifestation?: CodeableConcept[] }[];
};

export type Observation = Resource & {
  resourceType: "Observation";
  status?: string;
  code?: CodeableConcept;
  effectiveDateTime?: string;
  issued?: string;
  valueQuantity?: Quantity;
  valueString?: string;
  valueCodeableConcept?: CodeableConcept;
  interpretation?: CodeableConcept[];
};

export type Immunization = Resource & {
  resourceType: "Immunization";
  status?: string;
  vaccineCode?: CodeableConcept;
  occurrenceDateTime?: string;
};

export type Encounter = Resource & {
  resourceType: "Encounter";
  status?: string;
  type?: CodeableConcept[];
  class?: Coding;
  period?: { start?: string };
  serviceProvider?: Reference;
};
```

- [ ] **Step 2: Write the failing test `src/lib/fhir/client.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { EpicError, ReconnectRequiredError } from "@/lib/epic/errors";
import { fhirSearch } from "./client";

const base = "https://fhir.example.org/api/FHIR/R4";

function bundle(ids: string[], next?: string) {
  return Response.json({
    resourceType: "Bundle",
    link: next ? [{ relation: "next", url: next }] : [],
    entry: [
      ...ids.map((id) => ({ resource: { resourceType: "Condition", id } })),
      { resource: { resourceType: "OperationOutcome", id: "oo" } },
    ],
  });
}

describe("fhirSearch", () => {
  it("sends the bearer token and follows same-origin next links", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(bundle(["a", "b"], `${base}/Condition?page=2`))
      .mockResolvedValueOnce(bundle(["c"]));
    const results = await fhirSearch({ baseUrl: `${base}/`, path: "Condition?patient=p1", resourceType: "Condition", accessToken: "at", fetchImpl });

    expect(results.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${base}/Condition?patient=p1`);
    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({ Authorization: "Bearer at", Accept: "application/fhir+json" });
    expect(fetchImpl.mock.calls[1][0]).toBe(`${base}/Condition?page=2`);
  });

  it("ignores next links on another origin", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(bundle(["a"], "https://evil.example/steal"));
    const results = await fhirSearch({ baseUrl: base, path: "Condition", resourceType: "Condition", accessToken: "at", fetchImpl });
    expect(results).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("stops after maxPages", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => bundle(["x"], `${base}/Condition?page=next`));
    await fhirSearch({ baseUrl: base, path: "Condition", resourceType: "Condition", accessToken: "at", fetchImpl, maxPages: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("asks for a reconnect on 401 and reports other failures", async () => {
    const unauthorized = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
    await expect(
      fhirSearch({ baseUrl: base, path: "Condition", resourceType: "Condition", accessToken: "at", fetchImpl: unauthorized }),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);

    const broken = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    await expect(
      fhirSearch({ baseUrl: base, path: "Condition", resourceType: "Condition", accessToken: "at", fetchImpl: broken }),
    ).rejects.toMatchObject({ stage: "fhir", status: 500 } satisfies Partial<EpicError>);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/lib/fhir/client.test.ts`
Expected: FAIL — cannot resolve `./client`.

- [ ] **Step 4: Implement `src/lib/fhir/client.ts`**

```ts
import { EpicError, ReconnectRequiredError } from "@/lib/epic/errors";
import type { Bundle, Resource } from "./types";

export async function fhirSearch<T extends Resource>({
  baseUrl,
  path,
  resourceType,
  accessToken,
  fetchImpl = fetch,
  maxPages = 5,
}: {
  baseUrl: string;
  path: string;
  resourceType: T["resourceType"];
  accessToken: string;
  fetchImpl?: typeof fetch;
  maxPages?: number;
}): Promise<T[]> {
  const root = baseUrl.replace(/\/+$/, "");
  const origin = new URL(root).origin;
  const results: T[] = [];
  let url: string | undefined = `${root}/${path}`;

  for (let page = 0; url && page < maxPages; page++) {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/fhir+json" },
      cache: "no-store",
    });
    if (response.status === 401) throw new ReconnectRequiredError();
    if (!response.ok) throw new EpicError("fhir", response.status);

    const bundle = (await response.json()) as Bundle;
    for (const entry of bundle.entry ?? []) {
      if (entry.resource?.resourceType === resourceType) results.push(entry.resource as T);
    }
    const next = bundle.link?.find((link) => link.relation === "next")?.url;
    url = next && new URL(next).origin === origin ? next : undefined;
  }
  return results;
}
```

- [ ] **Step 5: Run the tests and commit**

```bash
npx vitest run src/lib/fhir/client.test.ts
git add src/lib/fhir/types.ts src/lib/fhir/client.ts src/lib/fhir/client.test.ts
git commit -m "Add FHIR search client with same-origin paging"
```

Expected: PASS, 4 tests.

---

### Task 2: Normalizers, categories and date formatting

**Files:**
- Create: `src/lib/fhir/normalize.ts`, `src/lib/fhir/normalize.test.ts`, `src/lib/fhir/categories.ts`, `src/lib/fhir/format.ts`, `src/lib/fhir/format.test.ts`

**Interfaces:**
- Consumes: FHIR types (Task 1).
- Produces: `type RecordCategory = "condition" | "medication" | "allergy" | "lab" | "immunization" | "visit"`; `type RecordItem = { key: string; category: RecordCategory; title: string; date: string | null; detail: string | null; status: string | null; source: string }`; `normalizeCondition`, `normalizeMedication`, `normalizeAllergy`, `normalizeLab`, `normalizeImmunization`, `normalizeVisit` — each `(resource, source: string) => RecordItem`; `CATEGORIES: { category: RecordCategory; label: string; slug: string }[]`, `categoryForSlug(slug: string): RecordCategory | undefined`, `labelFor(category): string`; `formatRecordDate(value: string | null): string`, `yearOf(value: string | null): string`.

- [ ] **Step 1: Write the failing tests**

`src/lib/fhir/normalize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  normalizeAllergy,
  normalizeCondition,
  normalizeImmunization,
  normalizeLab,
  normalizeMedication,
  normalizeVisit,
} from "./normalize";

const source = "Example Health";

describe("normalizers", () => {
  it("reads a condition, preferring text over coding", () => {
    expect(
      normalizeCondition(
        {
          resourceType: "Condition",
          id: "c1",
          code: { text: "Type 2 diabetes", coding: [{ display: "Diabetes mellitus type 2" }] },
          clinicalStatus: { coding: [{ code: "active" }] },
          onsetDateTime: "2021-05-02",
        },
        source,
      ),
    ).toEqual({
      key: "Example Health|Condition/c1",
      category: "condition",
      title: "Type 2 diabetes",
      date: "2021-05-02",
      detail: null,
      status: "active",
      source,
    });
  });

  it("falls back to coding display, then to a neutral title", () => {
    expect(normalizeCondition({ resourceType: "Condition", id: "c2", code: { coding: [{ display: "Asthma" }] } }, source).title).toBe("Asthma");
    expect(normalizeCondition({ resourceType: "Condition", id: "c3" }, source).title).toBe("Unnamed condition");
  });

  it("reads a medication with its dosage instructions", () => {
    const item = normalizeMedication(
      {
        resourceType: "MedicationRequest",
        id: "m1",
        status: "active",
        medicationReference: { display: "Lisinopril 10 MG Oral Tablet" },
        authoredOn: "2025-06-19T14:00:00Z",
        dosageInstruction: [{ text: "Take 1 tablet by mouth daily" }],
      },
      source,
    );
    expect(item).toMatchObject({
      category: "medication",
      title: "Lisinopril 10 MG Oral Tablet",
      detail: "Take 1 tablet by mouth daily",
      status: "active",
    });
  });

  it("reads an allergy and its reaction", () => {
    const item = normalizeAllergy(
      {
        resourceType: "AllergyIntolerance",
        id: "a1",
        code: { text: "Penicillin" },
        reaction: [{ manifestation: [{ text: "Hives" }] }],
        clinicalStatus: { coding: [{ code: "active" }] },
      },
      source,
    );
    expect(item).toMatchObject({ category: "allergy", title: "Penicillin", detail: "Reaction: Hives", status: "active" });
  });

  it("reads a lab value with units and the health system's interpretation", () => {
    const item = normalizeLab(
      {
        resourceType: "Observation",
        id: "o1",
        status: "final",
        code: { text: "Hemoglobin A1c" },
        effectiveDateTime: "2025-06-19T09:10:00Z",
        valueQuantity: { value: 6.1, unit: "%" },
        interpretation: [{ text: "High" }],
      },
      source,
    );
    expect(item).toMatchObject({ category: "lab", title: "Hemoglobin A1c", detail: "6.1 %", status: "High" });
  });

  it("reads text lab values", () => {
    const item = normalizeLab(
      { resourceType: "Observation", id: "o2", code: { text: "Urine color" }, valueString: "Yellow", issued: "2024-01-02T00:00:00Z" },
      source,
    );
    expect(item).toMatchObject({ detail: "Yellow", date: "2024-01-02T00:00:00Z", status: null });
  });

  it("reads immunizations and visits", () => {
    expect(
      normalizeImmunization({ resourceType: "Immunization", id: "i1", vaccineCode: { text: "Influenza" }, occurrenceDateTime: "2024-10-01", status: "completed" }, source),
    ).toMatchObject({ category: "immunization", title: "Influenza", date: "2024-10-01" });
    expect(
      normalizeVisit(
        { resourceType: "Encounter", id: "e1", type: [{ text: "Office Visit" }], period: { start: "2025-06-19T08:30:00Z" }, serviceProvider: { display: "Primary Care Clinic" } },
        source,
      ),
    ).toMatchObject({ category: "visit", title: "Office Visit", detail: "Primary Care Clinic", date: "2025-06-19T08:30:00Z" });
  });
});
```

`src/lib/fhir/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatRecordDate, yearOf } from "./format";

describe("formatRecordDate", () => {
  it.each([
    ["2024-03-14", "Mar 14, 2024"],
    ["2024-03-14T23:30:00Z", "Mar 14, 2024"],
    ["2024-03", "Mar 2024"],
    ["2024", "2024"],
    [null, "Date not recorded"],
    ["not a date", "Date not recorded"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatRecordDate(value)).toBe(expected);
  });
});

describe("yearOf", () => {
  it("returns the year or Undated", () => {
    expect(yearOf("2023-11-02")).toBe("2023");
    expect(yearOf(null)).toBe("Undated");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/fhir/normalize.test.ts src/lib/fhir/format.test.ts`
Expected: FAIL — cannot resolve `./normalize` and `./format`.

- [ ] **Step 3: Implement `src/lib/fhir/normalize.ts`**

```ts
import type {
  AllergyIntolerance,
  CodeableConcept,
  Condition,
  Encounter,
  Immunization,
  MedicationRequest,
  Observation,
  Resource,
} from "./types";

export type RecordCategory = "condition" | "medication" | "allergy" | "lab" | "immunization" | "visit";

export type RecordItem = {
  key: string;
  category: RecordCategory;
  title: string;
  date: string | null;
  detail: string | null;
  status: string | null;
  source: string;
};

function textOf(concept: CodeableConcept | undefined): string | null {
  return concept?.text?.trim() || concept?.coding?.find((c) => c.display)?.display?.trim() || null;
}

function codeOf(concept: CodeableConcept | undefined): string | null {
  return concept?.coding?.find((c) => c.code)?.code ?? null;
}

function item(
  resource: Resource,
  source: string,
  fields: Omit<RecordItem, "key" | "source">,
): RecordItem {
  return { key: `${source}|${resource.resourceType}/${resource.id ?? "unknown"}`, source, ...fields };
}

export function normalizeCondition(r: Condition, source: string): RecordItem {
  return item(r, source, {
    category: "condition",
    title: textOf(r.code) ?? "Unnamed condition",
    date: r.onsetDateTime ?? r.recordedDate ?? null,
    detail: null,
    status: codeOf(r.clinicalStatus),
  });
}

export function normalizeMedication(r: MedicationRequest, source: string): RecordItem {
  return item(r, source, {
    category: "medication",
    title: textOf(r.medicationCodeableConcept) ?? r.medicationReference?.display ?? "Unnamed medication",
    date: r.authoredOn ?? null,
    detail: r.dosageInstruction?.find((d) => d.text)?.text ?? null,
    status: r.status ?? null,
  });
}

export function normalizeAllergy(r: AllergyIntolerance, source: string): RecordItem {
  const reaction = textOf(r.reaction?.[0]?.manifestation?.[0]);
  return item(r, source, {
    category: "allergy",
    title: textOf(r.code) ?? "Unnamed allergy",
    date: r.recordedDate ?? null,
    detail: reaction ? `Reaction: ${reaction}` : null,
    status: codeOf(r.clinicalStatus),
  });
}

export function normalizeLab(r: Observation, source: string): RecordItem {
  const quantity = r.valueQuantity?.value !== undefined ? `${r.valueQuantity.value} ${r.valueQuantity.unit ?? ""}`.trim() : null;
  return item(r, source, {
    category: "lab",
    title: textOf(r.code) ?? "Unnamed result",
    date: r.effectiveDateTime ?? r.issued ?? null,
    detail: quantity ?? r.valueString ?? textOf(r.valueCodeableConcept),
    // The health system's own interpretation (for example "High"), shown as recorded.
    status: textOf(r.interpretation?.[0]),
  });
}

export function normalizeImmunization(r: Immunization, source: string): RecordItem {
  return item(r, source, {
    category: "immunization",
    title: textOf(r.vaccineCode) ?? "Unnamed immunization",
    date: r.occurrenceDateTime ?? null,
    detail: null,
    status: r.status ?? null,
  });
}

export function normalizeVisit(r: Encounter, source: string): RecordItem {
  return item(r, source, {
    category: "visit",
    title: textOf(r.type?.[0]) ?? r.class?.display ?? "Visit",
    date: r.period?.start ?? null,
    detail: r.serviceProvider?.display ?? null,
    status: r.status ?? null,
  });
}
```

- [ ] **Step 4: Implement `src/lib/fhir/categories.ts` and `src/lib/fhir/format.ts`**

`src/lib/fhir/categories.ts`:

```ts
import type { RecordCategory } from "./normalize";

export const CATEGORIES: { category: RecordCategory; label: string; slug: string }[] = [
  { category: "condition", label: "Conditions", slug: "conditions" },
  { category: "medication", label: "Medications", slug: "medications" },
  { category: "allergy", label: "Allergies", slug: "allergies" },
  { category: "lab", label: "Lab results", slug: "labs" },
  { category: "immunization", label: "Immunizations", slug: "immunizations" },
  { category: "visit", label: "Visits", slug: "visits" },
];

export function categoryForSlug(slug: string): RecordCategory | undefined {
  return CATEGORIES.find((c) => c.slug === slug)?.category;
}

export function labelFor(category: RecordCategory): string {
  return CATEGORIES.find((c) => c.category === category)?.label ?? category;
}
```

`src/lib/fhir/format.ts`:

```ts
const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

export function formatRecordDate(value: string | null): string {
  if (!value) return "Date not recorded";
  if (/^\d{4}$/.test(value)) return value;
  if (/^\d{4}-\d{2}$/.test(value)) return monthFormat.format(new Date(`${value}-01T00:00:00Z`));
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? "Date not recorded" : dayFormat.format(date);
}

export function yearOf(value: string | null): string {
  return value && /^\d{4}/.test(value) ? value.slice(0, 4) : "Undated";
}
```

- [ ] **Step 5: Run the tests and commit**

```bash
npx vitest run src/lib/fhir/normalize.test.ts src/lib/fhir/format.test.ts
git add src/lib/fhir
git commit -m "Normalize FHIR resources into record items"
```

Expected: PASS, 14 tests.

---

### Task 3: Records aggregator

**Files:**
- Create: `src/lib/records.ts`, `src/lib/records.test.ts`, `src/lib/records-server.ts`

**Interfaces:**
- Consumes: `ConnectionSecrets`, `accessTokenFor`, `getConnectionSecrets`, `tokenKey`, `ReconnectRequiredError` (plan 03); `fhirSearch` (Task 1); normalizers (Task 2).
- Produces: `RECORD_QUERIES`, `type RecordProblem = { organizationName: string; kind: "reconnect" | "unavailable" }`, `type RecordsResult = { items: RecordItem[]; problems: RecordProblem[] }`, `gatherRecords(connections, deps): Promise<RecordsResult>`, `countByCategory(items): Record<RecordCategory, number>`; server-only `loadRecordsFor(userId: string): Promise<RecordsResult>` (request-deduplicated).

- [ ] **Step 1: Write the failing test `src/lib/records.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import type { ConnectionSecrets } from "@/lib/epic/connections";
import { EpicError, ReconnectRequiredError } from "@/lib/epic/errors";
import type { Resource } from "@/lib/fhir/types";
import { countByCategory, gatherRecords, RECORD_QUERIES } from "./records";

function connection(name: string, base: string): ConnectionSecrets {
  return {
    id: name,
    organizationName: name,
    fhirBaseUrl: base,
    scope: "s",
    connectedAt: new Date(),
    tokenEndpoint: `${base}/token`,
    patientId: `patient-${name}`,
    accessToken: "at",
    refreshToken: "rt",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
  };
}

const north = connection("North Clinic", "https://north.example/R4");
const south = connection("South Hospital", "https://south.example/R4");

function fakeSearch(byBase: Record<string, Partial<Record<string, Resource[]>>>) {
  return vi.fn(async ({ baseUrl, resourceType }: { baseUrl: string; resourceType: string }) => byBase[baseUrl]?.[resourceType] ?? []);
}

describe("RECORD_QUERIES", () => {
  it("scopes every search to the patient, with the categories Epic requires", () => {
    const paths = RECORD_QUERIES.map((q) => q.path("p 1"));
    expect(paths).toEqual([
      "Condition?patient=p%201&category=problem-list-item",
      "MedicationRequest?patient=p%201",
      "AllergyIntolerance?patient=p%201",
      "Observation?patient=p%201&category=laboratory",
      "Immunization?patient=p%201",
      "Encounter?patient=p%201",
    ]);
  });
});

describe("gatherRecords", () => {
  it("merges every connection, tags the source and sorts newest first", async () => {
    const search = fakeSearch({
      [north.fhirBaseUrl]: { Condition: [{ resourceType: "Condition", id: "c1", code: { text: "Asthma" }, onsetDateTime: "2019-01-01" } as Resource] },
      [south.fhirBaseUrl]: { Immunization: [{ resourceType: "Immunization", id: "i1", vaccineCode: { text: "Influenza" }, occurrenceDateTime: "2024-10-01" } as Resource] },
    });
    const result = await gatherRecords([north, south], { accessToken: async () => "at", search });

    expect(result.problems).toEqual([]);
    expect(result.items.map((i) => [i.title, i.source])).toEqual([
      ["Influenza", "South Hospital"],
      ["Asthma", "North Clinic"],
    ]);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: north.fhirBaseUrl, path: "Condition?patient=patient-North%20Clinic&category=problem-list-item" }));
  });

  it("keeps other connections when one needs to reconnect", async () => {
    const search = fakeSearch({
      [south.fhirBaseUrl]: { Encounter: [{ resourceType: "Encounter", id: "e1", period: { start: "2025-01-01" } } as Resource] },
    });
    const accessToken = vi.fn(async (c: ConnectionSecrets) => {
      if (c.id === north.id) throw new ReconnectRequiredError();
      return "at";
    });
    const result = await gatherRecords([north, south], { accessToken, search });
    expect(result.problems).toEqual([{ organizationName: "North Clinic", kind: "reconnect" }]);
    expect(result.items).toHaveLength(1);
  });

  it("reports a connection once when some of its searches fail", async () => {
    const search = vi.fn(async ({ resourceType }: { resourceType: string }) => {
      if (resourceType === "Encounter" || resourceType === "Immunization") throw new EpicError("fhir", 400);
      if (resourceType === "Condition") return [{ resourceType: "Condition", id: "c1" } as Resource];
      return [];
    });
    const result = await gatherRecords([north], { accessToken: async () => "at", search });
    expect(result.problems).toEqual([{ organizationName: "North Clinic", kind: "unavailable" }]);
    expect(result.items).toHaveLength(1);
  });

  it("puts undated items last", async () => {
    const search = fakeSearch({
      [north.fhirBaseUrl]: {
        Condition: [
          { resourceType: "Condition", id: "undated", code: { text: "B" } } as Resource,
          { resourceType: "Condition", id: "dated", code: { text: "A" }, recordedDate: "2020-02-02" } as Resource,
        ],
      },
    });
    const result = await gatherRecords([north], { accessToken: async () => "at", search });
    expect(result.items.map((i) => i.title)).toEqual(["A", "B"]);
  });
});

describe("countByCategory", () => {
  it("counts items in every category, including zeros", async () => {
    const search = fakeSearch({
      [north.fhirBaseUrl]: { Condition: [{ resourceType: "Condition", id: "c1" } as Resource, { resourceType: "Condition", id: "c2" } as Resource] },
    });
    const { items } = await gatherRecords([north], { accessToken: async () => "at", search });
    expect(countByCategory(items)).toEqual({ condition: 2, medication: 0, allergy: 0, lab: 0, immunization: 0, visit: 0 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/records.test.ts`
Expected: FAIL — cannot resolve `./records`.

- [ ] **Step 3: Implement `src/lib/records.ts`**

```ts
import type { ConnectionSecrets } from "@/lib/epic/connections";
import { EpicError, ReconnectRequiredError } from "@/lib/epic/errors";
import {
  normalizeAllergy,
  normalizeCondition,
  normalizeImmunization,
  normalizeLab,
  normalizeMedication,
  normalizeVisit,
  type RecordCategory,
  type RecordItem,
} from "@/lib/fhir/normalize";
import type { Resource } from "@/lib/fhir/types";

type Query = {
  category: RecordCategory;
  resourceType: string;
  path: (patientId: string) => string;
  normalize: (resource: never, source: string) => RecordItem;
};

const patient = (id: string) => `patient=${encodeURIComponent(id)}`;

// Epic requires a category on Condition and Observation searches.
export const RECORD_QUERIES: Query[] = [
  { category: "condition", resourceType: "Condition", path: (p) => `Condition?${patient(p)}&category=problem-list-item`, normalize: normalizeCondition },
  { category: "medication", resourceType: "MedicationRequest", path: (p) => `MedicationRequest?${patient(p)}`, normalize: normalizeMedication },
  { category: "allergy", resourceType: "AllergyIntolerance", path: (p) => `AllergyIntolerance?${patient(p)}`, normalize: normalizeAllergy },
  { category: "lab", resourceType: "Observation", path: (p) => `Observation?${patient(p)}&category=laboratory`, normalize: normalizeLab },
  { category: "immunization", resourceType: "Immunization", path: (p) => `Immunization?${patient(p)}`, normalize: normalizeImmunization },
  { category: "visit", resourceType: "Encounter", path: (p) => `Encounter?${patient(p)}`, normalize: normalizeVisit },
];

export type RecordProblem = { organizationName: string; kind: "reconnect" | "unavailable" };
export type RecordsResult = { items: RecordItem[]; problems: RecordProblem[] };

type Deps = {
  accessToken: (connection: ConnectionSecrets) => Promise<string>;
  search: (input: { baseUrl: string; path: string; resourceType: string; accessToken: string }) => Promise<Resource[]>;
};

async function fromConnection(connection: ConnectionSecrets, deps: Deps): Promise<RecordsResult> {
  const source = connection.organizationName;
  let accessToken: string;
  try {
    accessToken = await deps.accessToken(connection);
  } catch (error) {
    const kind = error instanceof ReconnectRequiredError ? "reconnect" : "unavailable";
    return { items: [], problems: [{ organizationName: source, kind }] };
  }

  const settled = await Promise.allSettled(
    RECORD_QUERIES.map(async (query) => {
      const resources = await deps.search({
        baseUrl: connection.fhirBaseUrl,
        path: query.path(connection.patientId),
        resourceType: query.resourceType,
        accessToken,
      });
      return resources.map((resource) => query.normalize(resource as never, source));
    }),
  );

  const items: RecordItem[] = [];
  let kind: RecordProblem["kind"] | null = null;
  for (const [i, result] of settled.entries()) {
    if (result.status === "fulfilled") {
      items.push(...result.value);
      continue;
    }
    const status = result.reason instanceof EpicError ? result.reason.status : undefined;
    console.error(`[records] ${RECORD_QUERIES[i].resourceType} failed ${status ?? "network"}`);
    if (result.reason instanceof ReconnectRequiredError) kind = "reconnect";
    else kind ??= "unavailable";
  }
  return { items, problems: kind ? [{ organizationName: source, kind }] : [] };
}

function timeOf(item: RecordItem): number {
  const time = item.date ? Date.parse(item.date.length === 4 ? `${item.date}-01-01` : item.date) : NaN;
  return Number.isNaN(time) ? -Infinity : time;
}

export async function gatherRecords(connections: ConnectionSecrets[], deps: Deps): Promise<RecordsResult> {
  const results = await Promise.all(connections.map((connection) => fromConnection(connection, deps)));
  const items = results.flatMap((r) => r.items).sort((a, b) => timeOf(b) - timeOf(a) || a.title.localeCompare(b.title));
  return { items, problems: results.flatMap((r) => r.problems) };
}

export function countByCategory(items: RecordItem[]): Record<RecordCategory, number> {
  const counts: Record<RecordCategory, number> = { condition: 0, medication: 0, allergy: 0, lab: 0, immunization: 0, visit: 0 };
  for (const item of items) counts[item.category] += 1;
  return counts;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/records.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Create the server wiring `src/lib/records-server.ts`**

```ts
import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";
import { getConnectionSecrets } from "@/lib/epic/connections";
import { accessTokenFor, tokenKey } from "@/lib/epic/server";
import { fhirSearch } from "@/lib/fhir/client";
import { gatherRecords, type RecordsResult } from "@/lib/records";

// Fetched live for every request and never stored. cache() de-duplicates within one request.
export const loadRecordsFor = cache(async (userId: string): Promise<RecordsResult> => {
  const connections = await getConnectionSecrets(db, tokenKey(), userId);
  return gatherRecords(connections, {
    accessToken: accessTokenFor,
    search: (input) => fhirSearch(input),
  });
});
```

- [ ] **Step 6: Commit**

```bash
npm run lint
git add src/lib/records.ts src/lib/records.test.ts src/lib/records-server.ts
git commit -m "Gather records live across connections with per-connection problems"
```

---

### Task 4: Dashboard home, category pages and sandbox walkthrough

**Files:**
- Create: `src/components/records/records.css`, `src/components/records/RecordList.tsx`, `src/components/records/Timeline.tsx`, `src/components/records/ProblemNotices.tsx`, `src/app/(app)/app/loading.tsx`, `src/app/(app)/app/records/[category]/page.tsx`
- Modify: `src/app/(app)/app/page.tsx`

**Interfaces:**
- Consumes: `requireOnboarded` (plan 02), `listConnections` (plan 03), `loadRecordsFor`, `countByCategory` (Task 3), `CATEGORIES`, `categoryForSlug`, `labelFor`, `formatRecordDate`, `yearOf` (Task 2), `FaceMark`.
- Produces: `RecordList({ items, showCategory? })`, `Timeline({ items })`, `ProblemNotices({ problems })`.

- [ ] **Step 1: Create the styles `src/components/records/records.css`**

```css
.record-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 28px 0 0;
  padding: 0;
  list-style: none;
}

.record-summary a {
  display: inline-flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 18px;
  border-radius: 999px;
  background: var(--surface);
  text-decoration: none;
  font-weight: 700;
}

.record-summary a:hover {
  background: var(--surface-2);
}

.record-summary b {
  color: var(--rasp-text);
  font-size: 18px;
}

.record-note {
  color: var(--muted);
  font-size: 14px;
  margin: 18px 0 0;
}

.timeline {
  margin-top: 48px;
  display: grid;
  gap: 36px;
}

.timeline h2 {
  margin: 0 0 14px;
  font-size: 22px;
  font-weight: 800;
  color: var(--text-2);
}

.record-list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.record {
  display: grid;
  grid-template-columns: 12px 1fr auto;
  gap: 14px;
  align-items: start;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 24px;
  padding: 16px 20px;
}

.record-dot {
  width: 10px;
  height: 10px;
  margin-top: 8px;
  border-radius: 50%;
  background: var(--rasp);
}

.record h3 {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
}

.record-detail {
  margin: 2px 0 0;
  color: var(--text-2);
  font-size: 15px;
}

.record-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  font-size: 12.5px;
  color: var(--muted);
}

.record-meta span {
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 1px 10px;
}

.record-date {
  font-size: 13.5px;
  color: var(--muted);
  white-space: nowrap;
}

.empty-record {
  display: grid;
  justify-items: start;
  gap: 16px;
  max-width: 560px;
  margin-top: 32px;
  background: var(--vinyl);
  color: var(--cream-ink);
  border-radius: 40px;
  padding: 36px;
}

.empty-record .avatar {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: #fff;
  display: grid;
  place-items: center;
}

.empty-record .avatar svg {
  width: 28px;
}

.empty-record h2 {
  margin: 0;
  font-size: 24px;
}

.empty-record p {
  margin: 0;
  color: var(--cream-ink-2);
}

.problem {
  margin: 20px 0 0;
  border-radius: 20px;
  padding: 14px 18px;
  background: var(--rasp-soft);
}

.problem a {
  color: var(--rasp-text);
  font-weight: 700;
}

.loading-orb {
  width: 88px;
  height: 88px;
  border-radius: 50%;
  background: var(--vinyl);
  box-shadow: var(--glow);
  display: grid;
  place-items: center;
  animation: breathe 2.4s ease-in-out infinite;
}

.loading-orb svg {
  width: 44px;
}

@keyframes breathe {
  50% {
    transform: scale(0.94);
  }
}

@media (max-width: 700px) {
  .record {
    grid-template-columns: 12px 1fr;
  }

  .record-date {
    grid-column: 2;
  }
}
```

- [ ] **Step 2: Create the record components**

`src/components/records/RecordList.tsx`:

```tsx
import { labelFor } from "@/lib/fhir/categories";
import { formatRecordDate } from "@/lib/fhir/format";
import type { RecordItem } from "@/lib/fhir/normalize";

export function RecordList({ items, showCategory = false }: { items: RecordItem[]; showCategory?: boolean }) {
  return (
    <ul className="record-list">
      {items.map((item) => (
        <li className="record" key={item.key}>
          <span className="record-dot" aria-hidden="true" />
          <div>
            <h3>{item.title}</h3>
            {item.detail ? <p className="record-detail">{item.detail}</p> : null}
            <div className="record-meta">
              {showCategory ? <span>{labelFor(item.category)}</span> : null}
              {item.status ? <span>{item.category === "lab" ? `Marked ${item.status}` : item.status}</span> : null}
              <span>From {item.source}</span>
            </div>
          </div>
          <time className="record-date" dateTime={item.date ?? undefined}>
            {formatRecordDate(item.date)}
          </time>
        </li>
      ))}
    </ul>
  );
}
```

`src/components/records/Timeline.tsx`:

```tsx
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
```

`src/components/records/ProblemNotices.tsx`:

```tsx
import Link from "next/link";
import type { RecordProblem } from "@/lib/records";

export function ProblemNotices({ problems }: { problems: RecordProblem[] }) {
  return (
    <>
      {problems.map((problem) => (
        <p className="problem" role="status" key={problem.organizationName}>
          {problem.kind === "reconnect" ? (
            <>
              {problem.organizationName} needs you to sign in again. <Link href="/app/connections">Reconnect</Link>
            </>
          ) : (
            <>We couldn&apos;t reach {problem.organizationName} just now, so some records may be missing.</>
          )}
        </p>
      ))}
    </>
  );
}
```

- [ ] **Step 3: Create the dashboard home and loading state**

`src/app/(app)/app/loading.tsx`:

```tsx
import { FaceMark } from "@/components/landing/marks";
import "@/components/records/records.css";

export default function Loading() {
  return (
    <section className="app-page" aria-busy="true">
      <div className="loading-orb">
        <FaceMark />
      </div>
      <p className="lede">Gathering your record from each health system.</p>
    </section>
  );
}
```

Replace `src/app/(app)/app/page.tsx` with:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { FaceMark } from "@/components/landing/marks";
import { ProblemNotices } from "@/components/records/ProblemNotices";
import { Timeline } from "@/components/records/Timeline";
import { db } from "@/lib/db";
import { listConnections } from "@/lib/epic/connections";
import { CATEGORIES } from "@/lib/fhir/categories";
import { requireOnboarded } from "@/lib/onboarding-guard";
import { countByCategory } from "@/lib/records";
import { loadRecordsFor } from "@/lib/records-server";
import "@/components/records/records.css";

export const metadata: Metadata = { title: "Your record | Wild Hearts Health" };

const TIMELINE_LIMIT = 40;

export default async function AppHome() {
  const { session, profile } = await requireOnboarded();
  const connections = await listConnections(db, session.user.id);

  if (connections.length === 0) {
    return (
      <section className="app-page">
        <h1>Welcome, {profile.preferredName}.</h1>
        <div className="empty-record">
          <span className="avatar">
            <FaceMark />
          </span>
          <h2>Your record starts with one connection.</h2>
          <p>Connect a health system and your conditions, medications, results and visits will gather here.</p>
          <Link className="btn btn-lg" href="/app/connections">
            Connect a health system
          </Link>
        </div>
      </section>
    );
  }

  const { items, problems } = await loadRecordsFor(session.user.id);
  const counts = countByCategory(items);

  return (
    <section className="app-page">
      <h1>{profile.preferredName}&apos;s record</h1>
      <p className="lede">
        From {connections.length === 1 ? connections[0].organizationName : `${connections.length} health systems`}, newest first.
      </p>
      <ProblemNotices problems={problems} />
      <ul className="record-summary" aria-label="Record summary">
        {CATEGORIES.map(({ category, label, slug }) => (
          <li key={category}>
            <Link href={`/app/records/${slug}`}>
              <b>{counts[category]}</b> {label}
            </Link>
          </li>
        ))}
      </ul>
      <p className="record-note">Shown as recorded by your health systems. Wild Hearts doesn&apos;t change or interpret it.</p>
      <Timeline items={items.slice(0, TIMELINE_LIMIT)} />
    </section>
  );
}
```

- [ ] **Step 4: Create the category page**

`src/app/(app)/app/records/[category]/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProblemNotices } from "@/components/records/ProblemNotices";
import { RecordList } from "@/components/records/RecordList";
import { categoryForSlug, labelFor } from "@/lib/fhir/categories";
import { requireOnboarded } from "@/lib/onboarding-guard";
import { loadRecordsFor } from "@/lib/records-server";
import "@/components/records/records.css";

export async function generateMetadata({ params }: PageProps<"/app/records/[category]">): Promise<Metadata> {
  const category = categoryForSlug((await params).category);
  return { title: `${category ? labelFor(category) : "Records"} | Wild Hearts Health` };
}

export default async function CategoryPage({ params }: PageProps<"/app/records/[category]">) {
  const category = categoryForSlug((await params).category);
  if (!category) notFound();

  const { session } = await requireOnboarded();
  const { items, problems } = await loadRecordsFor(session.user.id);
  const inCategory = items.filter((item) => item.category === category);

  return (
    <section className="app-page">
      <p>
        <Link href="/app">← Your record</Link>
      </p>
      <h1>{labelFor(category)}</h1>
      <ProblemNotices problems={problems} />
      {inCategory.length === 0 ? (
        <p className="lede">Nothing here from your connected health systems yet.</p>
      ) : (
        <div className="timeline">
          <RecordList items={inCategory} />
        </div>
      )}
      <p className="record-note">Shown as recorded by your health systems. Wild Hearts doesn&apos;t change or interpret it.</p>
    </section>
  );
}
```

- [ ] **Step 5: Walk through it against the Epic sandbox**

With `npm run dev`, signed in with a sandbox connection from plan 03:
1. `/app` briefly shows the breathing orb ("Gathering your record…"), then the heading, six category counts and a timeline grouped by year, each item tagged "From Epic sandbox (sample patients)".
2. Each category link lists only that category; `/app/records/nonsense` returns 404.
3. Server logs contain no FHIR content. If a `[records] <Type> failed 400` line appears, Epic wants different search parameters for that resource: check the resource's search spec on fhir.epic.com, update its `path` in `RECORD_QUERIES` and the matching expectation in `records.test.ts`, then re-run the tests.
4. In a database console, set the connection's `access_token_expires_at` to a past time and reload `/app`. Records still load (the token was refreshed), and `updated_at` changes.
5. Set `sealed_refresh_token` to null and the expiry to the past, then reload. The banner reads "… needs you to sign in again. Reconnect". Reconnecting from `/app/connections` clears it.
6. Disconnect everything: `/app` shows the "Your record starts with one connection" card.

- [ ] **Step 6: Run every check, commit and open the PR**

```bash
npm test
npm run lint
npm run build
npm run typecheck
git add src/components/records "src/app/(app)/app"
git commit -m "Show live records on the dashboard and per-category pages"
```

Push and open a PR titled "Dashboard 04: records viewer", listing the Step 5 walkthrough results and any `RECORD_QUERIES` changes made for Epic.
