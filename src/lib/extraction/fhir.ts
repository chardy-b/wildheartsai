import { createHash } from "node:crypto";
import { z } from "zod";
import type { WildcardFile } from "@/lib/wildcards";
import { resultSchema, type ExtractionResult } from "./contracts";

export const DOCUMENT_FHIR_VERSION = "pdf-fhir-r4/v1";
const namespace = "https://www.wildheartsai.com/fhir";
const tag = { system: `${namespace}/CodeSystem/review-status`, code: "unreviewed", display: "Machine extracted, not reviewed" };
const reference = z.object({ reference: z.string().min(1) }).strict();
const concept = z.object({ text: z.string().min(1) }).strict();
const metadata = z.object({ tag: z.array(z.object({ system: z.url(), code: z.string(), display: z.string() }).strict()) }).strict();
const quantity = z.object({ value: z.number().finite(), comparator: z.enum(["<", "<=", ">=", ">"]).optional(), unit: z.string().optional() }).strict();
const note = z.object({ text: z.string().min(1) }).strict();
const evidenceExtension = z.object({ url: z.literal(`${namespace}/StructureDefinition/source-page`), valuePositiveInt: z.number().int().positive() }).strict();

// Runtime validation of the R4 subset this mapper authors. This is deliberately
// separate from the permissive reader types; it does not assert a US Core profile.
const documentSchema = z.object({
  resourceType: z.literal("DocumentReference"), id: z.uuid(), meta: metadata,
  status: z.literal("current"), date: z.iso.datetime(), description: z.string(),
  content: z.array(z.object({ attachment: z.object({ contentType: z.string(), url: z.url().optional(), data: z.string().optional(), title: z.string() }).strict()
    .refine(a => Boolean(a.url) !== Boolean(a.data), "One attachment content source is required") }).strict()).min(1),
  relatesTo: z.array(z.object({ code: z.literal("transforms"), target: reference }).strict()).optional(),
}).strict();
const observationSchema = z.object({
  resourceType: z.literal("Observation"), id: z.uuid(), meta: metadata,
  status: z.literal("unknown"), code: concept,
  effectiveDateTime: z.string().optional(),
  valueQuantity: quantity.optional(), valueString: z.string().min(1).optional(),
  referenceRange: z.array(z.object({ text: z.string().min(1) }).strict()).optional(),
  derivedFrom: z.array(reference).min(1), note: z.array(note).min(1), extension: z.array(evidenceExtension).min(1),
}).strict().refine(r => Boolean(r.valueQuantity) !== Boolean(r.valueString), "One observation value is required");
const deviceSchema = z.object({ resourceType: z.literal("Device"), id: z.uuid(), deviceName: z.array(z.object({ name: z.string(), type: z.literal("user-friendly-name") }).strict()) }).strict();
const provenanceSchema = z.object({
  resourceType: z.literal("Provenance"), id: z.uuid(), target: z.array(reference).min(1), recorded: z.iso.datetime(),
  activity: concept, agent: z.array(z.object({ who: reference }).strict()).min(1),
  entity: z.array(z.object({ role: z.literal("source"), what: reference }).strict()).min(1),
}).strict();
export const documentBundleSchema = z.object({
  resourceType: z.literal("Bundle"), type: z.literal("collection"),
  entry: z.array(z.object({ fullUrl: z.string().startsWith("urn:uuid:"), resource: z.union([documentSchema, observationSchema, deviceSchema, provenanceSchema]) }).strict()).min(1),
}).strict().superRefine((bundle, ctx) => {
  const urls = new Set(bundle.entry.map(e => e.fullUrl));
  if (urls.size !== bundle.entry.length) ctx.addIssue({ code: "custom", message: "Duplicate resource identity" });
  for (const { resource } of bundle.entry) {
    const refs = resource.resourceType === "DocumentReference" ? resource.relatesTo?.map(r => r.target) ?? [] : resource.resourceType === "Observation" ? resource.derivedFrom : resource.resourceType === "Provenance"
      ? [...resource.target, ...resource.agent.map(a => a.who), ...resource.entity.map(e => e.what)] : [];
    if (refs.some(r => !urls.has(r.reference))) ctx.addIssue({ code: "custom", message: "Unresolved bundle reference" });
  }
});
export type DocumentBundle = z.infer<typeof documentBundleSchema>;
export type DocumentObservation = z.infer<typeof observationSchema>;
export type FhirMeasurement = { resource: DocumentObservation; source: ExtractionResult["measurements"][number]; issues: string[] };
export type DocumentFhir = { bundle: DocumentBundle; measurements: FhirMeasurement[]; summary: string | null; warnings: string[]; mapperVersion: string };

// Stable opaque UUIDs within one immutable run. New runs have separate identities
// until a later reviewed reconciliation step; this is not a clinical deduplicator.
function idFor(value: string) {
  const bytes = createHash("sha256").update(`${DOCUMENT_FHIR_VERSION}:${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const ref = (id: string) => ({ reference: `urn:uuid:${id}` });

export function clinicalDate(raw: string): string | undefined {
  const value = raw.trim();
  if (/^[1-9]\d{3}$/.test(value)) return value;
  if (/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value)) return value;
  if (/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value) && z.iso.date().safeParse(value).success) return value;
  // Ambiguous slash dates and times without known zones remain source text.
  return undefined;
}

export function clinicalQuantity(raw: string, unit: string): z.infer<typeof quantity> | undefined {
  const match = /^(<=|>=|<|>|≤|≥)?\s*([+-]?(?:0|[1-9]\d*)(?:\.\d+)?)$/.exec(raw.trim());
  if (!match) return undefined;
  const digits = match[2].replace(/[^0-9]/g, "").replace(/^0+/, "");
  const value = Number(match[2]);
  if (digits.length > 15 || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return undefined;
  const comparator = match[1]?.replace("≤", "<=").replace("≥", ">=") as z.infer<typeof quantity>["comparator"];
  // Preserve the source unit without inventing a UCUM mapping or converting scale.
  return { value, ...(comparator ? { comparator } : {}), ...(unit.trim() ? { unit: unit.trim() } : {}) };
}

export function documentFhir(input: { file: WildcardFile; sourceUrl: string; run?: { id: string; createdAt: string; result: ExtractionResult } }): DocumentFhir {
  const { file, run } = input;
  const documentId = idFor(`document:${file.id}`);
  const document = documentSchema.parse({ resourceType: "DocumentReference", id: documentId, meta: { tag: [tag] }, status: "current",
    date: new Date(file.uploadedAt).toISOString(), description: file.name,
    content: [{ attachment: { contentType: file.type.split(";")[0], url: input.sourceUrl, title: file.name } }],
  });
  const entries: DocumentBundle["entry"] = [{ fullUrl: ref(documentId).reference, resource: document }];
  const measurements: FhirMeasurement[] = [];
  let summary: string | null = null;
  const warnings = ["Patient identity has not been confirmed. No Patient resource or subject has been assigned.",
    "Extracted results are unreviewed. Clinical codes, clinical status and standardized units have not been inferred.",
    "The original file is linked, not embedded. Opening it requires access to this Wild Hearts account."];
  if (run) {
    const result = resultSchema.parse(run.result);
    if (result.summaryStatus === "accepted") {
      summary = result.summary;
      const summaryId = idFor(`summary:${file.id}:${run.id}`);
      entries.push({ fullUrl: ref(summaryId).reference, resource: documentSchema.parse({ resourceType: "DocumentReference", id: summaryId,
        meta: { tag: [tag] }, status: "current", date: new Date().toISOString(), description: `Machine-extracted summary of ${file.name}`,
        content: [{ attachment: { contentType: "text/plain", data: Buffer.from(summary, "utf8").toString("base64"), title: "Unreviewed machine summary" } }],
        relatesTo: [{ code: "transforms", target: ref(documentId) }],
      }) });
    }
    const seen = new Set<string>();
    for (const m of result.measurements) {
      const key = JSON.stringify(m);
      if (seen.has(key)) continue;
      seen.add(key);
      const issues: string[] = [];
      const valueQuantity = clinicalQuantity(m.value, m.unit);
      const date = clinicalDate(m.date);
      if (!valueQuantity) issues.push("Value retained as text; numeric interpretation needs review.");
      if (!m.unit.trim()) issues.push("No source unit was stated.");
      if (!date) issues.push(m.date.trim() ? "Source date needs review; no clinical date was assigned." : "No clinical date was stated.");
      if (!m.name.trim()) { warnings.push("An unnamed measurement was omitted."); continue; }
      const resource = observationSchema.parse({ resourceType: "Observation", id: idFor(`observation:${file.id}:${run.id}:${key}`), meta: { tag: [tag] },
        status: "unknown", code: { text: m.name.trim() }, ...(date ? { effectiveDateTime: date } : {}),
        ...(valueQuantity ? { valueQuantity } : { valueString: m.value }),
        ...(m.range.trim() ? { referenceRange: [{ text: m.range }] } : {}), derivedFrom: [ref(documentId)],
        extension: [{ url: `${namespace}/StructureDefinition/source-page`, valuePositiveInt: m.page }],
        note: [{ text: "Unreviewed machine extraction; patient identity and source clinical status are unconfirmed." },
          { text: `Source page ${m.page}: ${m.evidence}` },
          { text: `Source fields: ${JSON.stringify({ name: m.name, value: m.value, unit: m.unit, date: m.date, range: m.range })}` }],
      });
      measurements.push({ resource, source: m, issues });
      entries.push({ fullUrl: ref(resource.id).reference, resource });
    }
    warnings.push(...result.warnings.map(w => `Extraction: ${w}`));
    const deviceId = idFor("mapper");
    entries.push({ fullUrl: ref(deviceId).reference, resource: { resourceType: "Device", id: deviceId,
      deviceName: [{ name: `Wild Hearts document conversion ${DOCUMENT_FHIR_VERSION}`, type: "user-friendly-name" }] } });
    const provenanceId = idFor(`provenance:${file.id}:${run.id}`);
    entries.push({ fullUrl: ref(provenanceId).reference, resource: { resourceType: "Provenance", id: provenanceId,
      target: entries.filter(e => e.resource.resourceType !== "Device").map(e => ({ reference: e.fullUrl })), recorded: new Date().toISOString(),
      activity: { text: `Machine extraction ${result.method}; run ${run.id}; mapping ${DOCUMENT_FHIR_VERSION}. Not a clinical attestation.` },
      agent: [{ who: ref(deviceId) }], entity: [{ role: "source", what: ref(documentId) }],
    } });
  } else warnings.push("No completed extraction is available. Only the original document is represented.");
  return { bundle: documentBundleSchema.parse({ resourceType: "Bundle", type: "collection", entry: entries }), measurements, summary, warnings,
    mapperVersion: DOCUMENT_FHIR_VERSION };
}
