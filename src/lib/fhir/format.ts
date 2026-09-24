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
