import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SyncWatcher } from "@/components/app/SyncWatcher";
import { ProblemNotices } from "@/components/records/ProblemNotices";
import { RecordList } from "@/components/records/RecordList";
import { RecordsLoading } from "@/components/records/RecordsLoading";
import { TimelineFilterForm, TimelinePager } from "@/components/records/TimelineControls";
import { categoryForSlug, labelFor } from "@/lib/fhir/categories";
import type { RecordCategory } from "@/lib/fhir/normalize";
import { requireOnboarded } from "@/lib/onboarding-guard";
import { loadSourcesFor, loadTimelineFor } from "@/lib/records-server";
import { hasFilters, parseCursor, parseFilters, sourceTones } from "@/lib/timeline";
import "@/components/records/records.css";

export async function generateMetadata({ params }: PageProps<"/app/records/[category]">): Promise<Metadata> {
  const category = categoryForSlug((await params).category);
  return { title: `${category ? labelFor(category) : "Records"} | Wild Hearts Health` };
}

async function CategoryRecords({ userId, category, slug, params }: { userId: string; category: RecordCategory; slug: string; params: Record<string, string | string[] | undefined> }) {
  const allSources = await loadSourcesFor(userId);
  // The category comes from the path; the form and links carry only the other filters.
  const filters = { ...parseFilters(params, allSources), categories: [] };
  const cursor = parseCursor(params.before);
  const { sources, items, related, next, problems } = await loadTimelineFor(userId, { ...filters, categories: [category] }, cursor);
  const tones = sourceTones(sources);
  const path = `/app/records/${slug}`;
  return (
    <>
      <ProblemNotices problems={problems} />
      <SyncWatcher active={problems.some((p) => p.kind === "importing")} />
      <TimelineFilterForm action={path} sources={sources} filters={filters} tones={tones} showType={false} />
      {items.length === 0 ? (
        <p className="lede">{hasFilters(filters) ? "No records match these filters." : "Nothing here from your connected health systems yet."}</p>
      ) : (
        <div className="timeline">
          <RecordList items={items} related={related} tones={tones} />
        </div>
      )}
      <TimelinePager path={path} filters={filters} next={next} paged={cursor !== null} />
    </>
  );
}

export default async function CategoryPage({ params, searchParams }: PageProps<"/app/records/[category]">) {
  // Checked before anything streams, so an unknown category is a real 404.
  const { category: slug } = await params;
  const category = categoryForSlug(slug);
  if (!category) notFound();

  const { session } = await requireOnboarded();

  return (
    <section className="app-page">
      <p>
        <Link href="/app">← Your record</Link>
      </p>
      <h1>{labelFor(category)}</h1>
      <Suspense fallback={<RecordsLoading />}>
        <CategoryRecords userId={session.user.id} category={category} slug={slug} params={await searchParams} />
      </Suspense>
      <p className="record-note">Shown as recorded by your health systems. Wild Hearts doesn&apos;t change or interpret it.</p>
    </section>
  );
}
