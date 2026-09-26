import Link from "next/link";
import { CATEGORIES } from "@/lib/fhir/categories";
import type { SourceSummary } from "@/lib/sources";
import { filterQuery, hasFilters, type TimelineCursor, type TimelineFilters } from "@/lib/timeline";

// Filters as a plain GET form, so they work without JavaScript and every view has a URL.
export function TimelineFilterForm({
  action,
  sources,
  filters,
  tones,
  showType = true,
}: {
  action: string;
  sources: SourceSummary[];
  filters: TimelineFilters;
  tones: Record<string, number>;
  showType?: boolean;
}) {
  const typeSlug = CATEGORIES.find((c) => c.category === filters.categories[0])?.slug ?? "";
  return (
    <form className="timeline-filters" action={action} method="get" aria-label="Filter records">
      {sources.length > 1 ? (
        <fieldset>
          <legend>Health systems</legend>
          {sources.map((source) => (
            <label key={source.id} className={`source-tag tone-${tones[source.id]}`}>
              <input type="checkbox" name="org" value={source.id} defaultChecked={filters.sourceIds.includes(source.id)} />
              {source.organizationName}
            </label>
          ))}
        </fieldset>
      ) : null}
      {showType ? (
        <label>
          <span>Type</span>
          <select name="type" defaultValue={typeSlug}>
            <option value="">All types</option>
            {CATEGORIES.map(({ slug, label }) => (
              <option key={slug} value={slug}>
                {label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label>
        <span>From</span>
        <input type="date" name="from" defaultValue={filters.from ?? ""} />
      </label>
      <label>
        <span>To</span>
        <input type="date" name="to" defaultValue={filters.to ?? ""} />
      </label>
      <div className="timeline-filter-actions">
        <button className="btn btn-ghost" type="submit">
          Apply
        </button>
        {hasFilters({ ...filters, categories: showType ? filters.categories : [] }) ? (
          <Link href={action}>Clear filters</Link>
        ) : null}
      </div>
    </form>
  );
}

export function TimelinePager({
  path,
  filters,
  next,
  paged,
}: {
  path: string;
  filters: TimelineFilters;
  next: TimelineCursor | null;
  paged: boolean;
}) {
  if (!next && !paged) return null;
  return (
    <nav className="timeline-pager" aria-label="More records">
      {paged ? <Link href={`${path}${filterQuery(filters)}`}>Back to newest</Link> : <span />}
      {next ? (
        <Link className="btn btn-ghost" href={`${path}${filterQuery(filters, next)}`}>
          Older records
        </Link>
      ) : null}
    </nav>
  );
}
