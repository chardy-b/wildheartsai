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

// UCUM unit codes as sent by health systems, shown the way people write them.
const UNITS: Record<string, string> = {
  Cel: "°C",
  "[degF]": "°F",
  "mm[Hg]": "mmHg",
  "[lb_av]": "lb",
  "[oz_av]": "oz",
  "[in_i]": "in",
  "[ft_i]": "ft",
  "kg/m2": "kg/m²",
  "/min": "/min",
  "{beats}/min": "beats/min",
  "{breaths}/min": "breaths/min",
};

export function readableUnit(unit: string | undefined): string {
  return unit ? (UNITS[unit] ?? unit) : "";
}

// "37.2 °C", "68.5 kg", "5.1": a value with its unit, when there is one. °C and °F sit
// right after the number would be closer to print style, but a space reads fine on screen.
export function quantityText(quantity: { value?: number; unit?: string } | undefined): string | null {
  if (quantity?.value === undefined) return null;
  return `${quantity.value} ${readableUnit(quantity.unit)}`.trim();
}
