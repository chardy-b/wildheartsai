import { z } from "zod";
import { CATEGORIES } from "@/lib/fhir/categories";
import { summaryContentSchema } from "./contracts";

// Limits are part of the tool boundary, not a prompt convention. The service permits at most
// six sequential calls in a run; these schemas reject incomplete or oversized calls before any
// database operation begins.
export const CHAT_MAX_TOOL_CALLS = 6;
export const CHAT_MAX_CANDIDATES = 200;
export const CHAT_MAX_RESULTS = 20;
export const CHAT_MAX_RECORD_IDS = 20;
export const CHAT_MAX_NOTE_CHARS = 12_000;

const category = z.enum(CATEGORIES.map((entry) => entry.category) as [string, ...string[]]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const uuid = z.uuid();

export const getDataCoverageInput = z.object({}).strict();
export const findRecordsInput = z
  .object({
    categories: z.array(category).max(CATEGORIES.length).optional(),
    resourceTypes: z.array(z.string().min(1).max(80)).max(20).optional(),
    sourceIds: z.array(uuid).max(20).optional(),
    from: date.optional(),
    to: date.optional(),
    query: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(CHAT_MAX_RESULTS).default(CHAT_MAX_RESULTS),
  })
  .strict();
export const readRecordsInput = z.object({ recordIds: z.array(uuid).min(1).max(CHAT_MAX_RECORD_IDS), includeDetails: z.boolean().default(false) }).strict();
export const readStoredNoteInput = z.object({ attachmentId: uuid }).strict();
export const calculateLabTrendInput = z.object({ recordIds: z.array(uuid).min(2).max(CHAT_MAX_RECORD_IDS) }).strict();
export const findSavedSummariesInput = z.object({ query: z.string().trim().min(1).max(200).optional(), limit: z.number().int().min(1).max(10).default(10) }).strict();
export const saveSummaryInput = z
  .object({
    title: z.string().trim().min(1).max(500),
    text: z.string().trim().min(1).max(20_000),
    coverageState: z.enum(["complete", "partial", "unknown"]),
    // The model supplies owned target citations only. Evidence-row ids and summary idempotency
    // keys are server-generated so free-form model text never becomes unsealed metadata.
    evidence: z.array(z.object({ kind: z.enum(["record", "note"]), targetId: uuid }).strict()).max(100),
  })
  .strict();

export const chatToolSchemas = {
  get_data_coverage: getDataCoverageInput,
  find_records: findRecordsInput,
  read_records: readRecordsInput,
  read_stored_note: readStoredNoteInput,
  calculate_lab_trend: calculateLabTrendInput,
  find_saved_summaries: findSavedSummariesInput,
  save_summary: saveSummaryInput,
} as const;

export type ChatToolName = keyof typeof chatToolSchemas;

export const chatToolDescriptions: Record<ChatToolName, string> = {
  get_data_coverage: "Report the person's stored sources, available categories, latest sync state, and known import gaps. Never infer that missing data means a negative finding.",
  find_records: "Find a bounded page of current, nonremoved stored records. Results include opaque citation handles and disclose when the candidate scan is truncated.",
  read_records: "Read compact summaries and selected display fields for owned record citation handles. It never returns a raw FHIR bundle.",
  read_stored_note: "Read text already stored for an owned note attachment. It never fetches from Epic or any network source.",
  calculate_lab_trend: "Compare compatible, retrieved quantitative lab observations deterministically. It refuses mixed tests or units and does not make a clinical interpretation.",
  find_saved_summaries: "Find the person's encrypted saved summaries and return their freshness and evidence handles.",
  save_summary: "Save a derived personal summary with owned supporting evidence. Each evidence targetId must be the citation id returned by read_records or read_stored_note; the repository creates evidence handles and sets provenance, source coverage and freshness metadata.",
};

// Zod 4's JSON-Schema output is consumed directly by the Pi adapter. Keeping it beside the
// executable Zod schemas prevents a prompt/tool definition mismatch.
export const chatToolJsonSchemas: Record<ChatToolName, object> = Object.fromEntries(
  Object.entries(chatToolSchemas).map(([name, schema]) => [name, z.toJSONSchema(schema)]),
) as Record<ChatToolName, object>;

export function parseToolInput<T extends ChatToolName>(name: T, input: unknown): z.infer<(typeof chatToolSchemas)[T]> {
  return chatToolSchemas[name].parse(input) as z.infer<(typeof chatToolSchemas)[T]>;
}

// Kept here as a compile-time guard: saved summaries intentionally accept a smaller model-facing
// input than the encrypted persisted envelope. `saveSummary` fills provenance and coverage.
export type PersistedSummaryEnvelope = z.infer<typeof summaryContentSchema>;
