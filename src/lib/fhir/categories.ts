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
