export type FieldNode = { label: string; value?: string; children?: FieldNode[] };

const MAX_NODES = 400;
const ACRONYMS: Record<string, string> = { id: "ID", url: "URL", uri: "URI", udi: "UDI", npi: "NPI" };

// "effectiveDateTime" -> "Effective date time"
export function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((word) => ACRONYMS[word.toLowerCase()] ?? word.toLowerCase());
  const [first = "", ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

// Every field the health system sent, for the "All fields" part of a record's
// expanded view. Capped so an unusually large record can't flood the page.
export function fieldTree(value: Record<string, unknown>): FieldNode[] {
  let budget = MAX_NODES;
  let truncated = false;

  const build = (label: string, v: unknown): FieldNode | null => {
    if (isEmpty(v)) return null;
    if (budget <= 0) {
      truncated = true;
      return null;
    }
    budget -= 1;
    if (Array.isArray(v)) {
      if (v.length === 1) {
        const only = build(label, v[0]);
        if (only) budget += 1;
        return only;
      }
      return { label, children: v.map((item, i) => build(String(i + 1), item)).filter((n): n is FieldNode => n !== null) };
    }
    if (typeof v === "object") return { label, children: children(v as Record<string, unknown>) };
    return { label, value: String(v) };
  };

  const children = (object: Record<string, unknown>) =>
    Object.entries(object)
      .map(([key, v]) => build(fieldLabel(key), v))
      .filter((n): n is FieldNode => n !== null);

  const tree = children(value);
  if (truncated) tree.push({ label: "More fields not shown", value: "This record is unusually large." });
  return tree;
}
