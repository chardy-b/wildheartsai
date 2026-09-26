// FHIR dates can be partial ('2019', '2019-04', '2019-04-05') or full instants.
// The timeline sorts on a timestamp, so partial dates become the start of their
// period (UTC), with the precision kept so they display as recorded.
export type DatePrecision = "year" | "month" | "day" | "instant";

export function effectiveDate(value: string | null): { at: Date; precision: DatePrecision } | null {
  if (!value) return null;
  let precision: DatePrecision;
  let iso: string;
  if (/^\d{4}$/.test(value)) [precision, iso] = ["year", `${value}-01-01T00:00:00Z`];
  else if (/^\d{4}-\d{2}$/.test(value)) [precision, iso] = ["month", `${value}-01T00:00:00Z`];
  else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) [precision, iso] = ["day", `${value}T00:00:00Z`];
  else [precision, iso] = ["instant", value];
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : { at, precision };
}
