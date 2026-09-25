import type { RecordCategory } from "./normalize";

// Every category, in the order the dashboard lists them.
export const CATEGORIES: { category: RecordCategory; label: string; slug: string }[] = [
  { category: "condition", label: "Conditions", slug: "conditions" },
  { category: "medication", label: "Medications", slug: "medications" },
  { category: "allergy", label: "Allergies", slug: "allergies" },
  { category: "lab", label: "Lab results", slug: "labs" },
  { category: "report", label: "Reports", slug: "reports" },
  { category: "vital", label: "Vitals", slug: "vitals" },
  { category: "immunization", label: "Immunizations", slug: "immunizations" },
  { category: "visit", label: "Visits", slug: "visits" },
  { category: "note", label: "Notes", slug: "notes" },
  { category: "procedure", label: "Procedures", slug: "procedures" },
  { category: "order", label: "Orders", slug: "orders" },
  { category: "fill", label: "Pharmacy fills", slug: "pharmacy" },
  { category: "careTeam", label: "Care team", slug: "care-team" },
  { category: "carePlan", label: "Care plans", slug: "care-plans" },
  { category: "goal", label: "Goals", slug: "goals" },
  { category: "social", label: "Social history", slug: "social-history" },
  { category: "device", label: "Devices", slug: "devices" },
  { category: "coverage", label: "Insurance", slug: "insurance" },
];

export function categoryForSlug(slug: string): RecordCategory | undefined {
  return CATEGORIES.find((c) => c.slug === slug)?.category;
}

export function labelFor(category: RecordCategory): string {
  return CATEGORIES.find((c) => c.category === category)?.label ?? category;
}
