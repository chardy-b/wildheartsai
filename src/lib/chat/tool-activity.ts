import { CATEGORIES } from "@/lib/fhir/categories";

export const TOOL_LABELS: Record<string, string> = {
  get_data_coverage: "Checking which records are available", find_records: "Searching your records",
  read_records: "Reading records", read_stored_note: "Reading a saved note",
  calculate_lab_trend: "Comparing lab results", find_saved_summaries: "Finding saved summaries",
  save_summary: "Saving a health summary", search_research: "Searching health research",
  read_research: "Reading research", lookup: "Looking up information",
};

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "";
const plural = (count: number, singular: string, multiple = `${singular}s`) => `${count} ${count === 1 ? singular : multiple}`;
const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
const RESOURCE_LABELS: Record<string, string> = {
  Observation: "observations", Condition: "conditions", MedicationRequest: "medication prescriptions",
  MedicationStatement: "medication statements", DiagnosticReport: "diagnostic reports",
  DocumentReference: "documents", Encounter: "visits", Procedure: "procedures",
  AllergyIntolerance: "allergies", Immunization: "immunizations", CarePlan: "care plans",
};

// Only concise display metadata leaves the tool boundary; never copy raw arguments,
// record identifiers, note text or credentials into activity events.
export function describeToolActivity(tool: string, raw: unknown): string {
  const input = object(raw);
  const query = text(input.query);
  let label = TOOL_LABELS[tool] ?? TOOL_LABELS.lookup;
  if (tool === "find_records") {
    const categories = Array.isArray(input.categories) ? input.categories.flatMap(value => {
      const entry = CATEGORIES.find(entry => entry.category === value);
      return entry ? [entry.label.toLowerCase()] : [];
    }) : [];
    label = `Searching ${categories.length ? categories.join(", ") : "your records"}`;
    if (Array.isArray(input.resourceTypes) && input.resourceTypes.length) {
      const types = input.resourceTypes.flatMap(value => typeof value === "string" && Object.hasOwn(RESOURCE_LABELS, value) ? [RESOURCE_LABELS[value]] : []);
      if (types.length) label += ` (${types.join(", ")})`;
    }
  }
  if (["find_records", "find_saved_summaries", "search_research"].includes(tool) && query) label += ` for “${query}”`;
  if (tool === "find_records") {
    const from = date(input.from), to = date(input.to);
    if (from && to) label += ` from ${from} to before ${to}`;
    else if (from) label += ` from ${from}`;
    else if (to) label += ` before ${to}`;
    if (Array.isArray(input.sourceIds) && input.sourceIds.length) label += ` across ${plural(input.sourceIds.length, "selected source")}`;
  }
  if (["read_records", "calculate_lab_trend"].includes(tool) && Array.isArray(input.recordIds)) {
    label = tool === "read_records" ? `Reading ${plural(input.recordIds.length, "selected record")}${input.includeDetails ? " in detail" : ""}` : `Comparing ${plural(input.recordIds.length, "lab result")}`;
  }
  return label.slice(0, 600);
}

export function summarizeToolActivity(tool: string, reply: unknown): { description?: string; outcome?: string } {
  const envelope = object(reply);
  if (envelope.status === "failed") return {};
  const output = object(envelope.output ?? reply);
  const items = Array.isArray(envelope.output) ? envelope.output : Array.isArray(output.items) ? output.items : undefined;
  if (tool === "find_records" || tool === "search_research") {
    const results = tool === "find_records" ? output.records : output.hits;
    if (!Array.isArray(results)) return {};
    return { outcome: `${results.length ? `${plural(results.length, "result")} returned` : "No matching results"}${output.truncated ? " · Search limited" : ""}` };
  }
  if (tool === "read_records" && items) {
    const titles = [...new Set(items.map(item => text(object(object(item).summary).title)).filter(Boolean))];
    return {
      ...(titles.length ? { description: `Reading records: ${titles.slice(0, 2).map(title => `“${title}”`).join(", ")}${titles.length > 2 ? ` and ${titles.length - 2} more` : ""}`.slice(0, 600) } : {}),
      outcome: items.length ? `${plural(items.length, "record")} read` : "No records available",
    };
  }
  if (tool === "find_saved_summaries" && items) return { outcome: items.length ? `${plural(items.length, "summary", "summaries")} found` : "No matching summaries" };
  if (tool === "get_data_coverage" && Array.isArray(output.sources) && Array.isArray(output.categories)) {
    const total = output.categories.reduce((sum, value) => sum + (typeof object(value).count === "number" ? object(value).count as number : 0), 0);
    return { outcome: `${plural(total, "record")} across ${plural(output.sources.length, "source")}` };
  }
  if (tool === "read_stored_note" && typeof output.available === "boolean") return { outcome: output.available ? `1 note read${output.truncated ? " · Excerpt only" : ""}` : "Note unavailable" };
  if (tool === "calculate_lab_trend" && typeof output.ok === "boolean") return output.ok && Array.isArray(output.points)
    ? { ...(text(output.test) ? { description: `Comparing results for “${text(output.test)}”` } : {}), outcome: `${plural(output.points.length, "lab result")} compared` }
    : { outcome: "Results could not be compared" };
  if (tool === "read_research" && typeof output.excerpt === "string") return { ...(text(output.title) ? { description: `Reading research: “${text(output.title)}”` } : {}), outcome: `1 research passage read${output.truncated ? " · Excerpt only" : ""}` };
  if (tool === "save_summary" && typeof output.id === "string") return { outcome: "1 summary saved" };
  return {};
}
