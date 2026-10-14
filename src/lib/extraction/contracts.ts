import { z } from "zod";

export const METHODS = ["native", "tesseract", "docling", "vision"] as const;
export const methodSchema = z.enum(METHODS);
const short = z.string().max(200);
export const boxSchema = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)])
  .refine(([x, y, r, b]) => x <= r && y <= b);
export const piiSchema = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), label: short }).strict().refine(s => s.end > s.start);
export const measurementSchema = z.object({ name: short, value: short, unit: short, date: short, range: short, page: z.number().int().positive(), evidence: z.string().max(2000) }).strict();
export const pageSchema = z.object({
  page: z.number().int().positive(), text: z.string().max(100_000),
  words: z.array(z.object({ text: z.string().max(2000), box: boxSchema }).strict()).max(20_000),
  figures: z.array(z.object({ box: boxSchema, caption: z.string().max(2000), origin: z.enum(["text", "vision", "unknown"]) }).strict()).max(200),
  tables: z.array(z.array(z.array(z.string().max(4000)).max(100)).max(1000)).max(100),
  foregroundCoverage: z.number().min(0).max(1).nullable(),
  redaction: z.object({
    rules: z.array(piiSchema).max(10_000), openmed: z.array(piiSchema).max(10_000), combined: z.array(piiSchema).max(10_000),
    text: z.string().max(100_000),
  }).strict(),
}).strict();
export const resultSchema = z.object({
  version: z.literal(1), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), method: methodSchema,
  manifest: z.record(z.string().max(100), z.string().max(2000)), elapsedMs: z.number().nonnegative(),
  pages: z.array(pageSchema).min(1).max(100), totalPages: z.number().int().min(1).max(100),
  summary: z.string().max(12_000), summaryStatus: z.enum(["accepted", "withheld"]),
  ageAtEncounter: z.number().int().min(0).max(120).nullable(),
  measurements: z.array(measurementSchema).max(2000), warnings: z.array(short).max(100),
}).strict().superRefine((r, ctx) => {
  if (r.pages.length !== r.totalPages || new Set(r.pages.map(p => p.page)).size !== r.totalPages || r.pages.some(p => p.page > r.totalPages)) ctx.addIssue({ code: "custom", message: "Incomplete pages" });
  if (r.summaryStatus === "withheld" && r.summary) ctx.addIssue({ code: "custom", message: "Withheld summary must be empty" });
  if (r.summaryStatus === "accepted" && !r.summary.trim()) ctx.addIssue({ code: "custom", message: "Accepted summary must be nonempty" });
  for (const m of r.measurements) {
    const page = r.pages.find(p => p.page === m.page);
    if (!page || !m.evidence || !page.text.includes(m.evidence) || !m.value || ![m.value, m.unit, m.date, m.range].every(v => m.evidence.includes(v)) || !m.evidence.toLocaleLowerCase("en").includes(m.name.toLocaleLowerCase("en"))) ctx.addIssue({ code: "custom", message: "Measurement requires source evidence" });
  }
  for (const p of r.pages) for (const spans of [p.redaction.rules, p.redaction.openmed, p.redaction.combined]) {
    if (spans.some(s => s.end > Array.from(p.text).length)) ctx.addIssue({ code: "custom", message: "Invalid offsets" });
  }
});
export const referenceSchema = z.object({
  version: z.literal(1), split: z.enum(["train", "validation", "test"]),
  pages: z.array(z.object({ page: z.number().int().positive(), text: z.string().max(30_000), pii: z.array(piiSchema).max(3000) }).strict()).min(1).max(100),
  measurements: z.array(measurementSchema).max(2000),
  measurementsComplete: z.boolean(),
  expectedAgeAtEncounter: z.number().int().min(0).max(120).nullable().optional(),
}).strict().superRefine((r, ctx) => {
  if (new Set(r.pages.map(p => p.page)).size !== r.pages.length) ctx.addIssue({ code: "custom", message: "Duplicate page" });
  if (r.measurements.some(m => !r.pages.some(p => p.page === m.page))) ctx.addIssue({ code: "custom", message: "Measurements require a labeled page" });
  for (const p of r.pages) if (p.pii.some(s => s.end > Array.from(p.text).length)) ctx.addIssue({ code: "custom", message: "Invalid reference offsets" });
});
export const createSchema = z.object({ fileIds: z.array(z.uuid()).min(1).max(20), methods: z.array(methodSchema).min(1).max(4), encounterDate: z.iso.date().optional() }).strict();
export type ExtractionResult = z.infer<typeof resultSchema>;
export type Reference = z.infer<typeof referenceSchema>;
export type PiiSpan = z.infer<typeof piiSchema>;
