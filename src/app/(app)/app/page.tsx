import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FaceMark } from "@/components/landing/marks";
import { SyncWatcher } from "@/components/app/SyncWatcher";
import { ProblemNotices } from "@/components/records/ProblemNotices";
import { RecordsLoading } from "@/components/records/RecordsLoading";
import { Timeline } from "@/components/records/Timeline";
import { TimelineFilterForm, TimelinePager } from "@/components/records/TimelineControls";
import { CATEGORIES } from "@/lib/fhir/categories";
import { requireOnboarded } from "@/lib/onboarding-guard";
import { loadSourcesFor, loadTimelineFor } from "@/lib/records-server";
import { countsFor, hasFilters, parseCursor, parseFilters, sourceTones } from "@/lib/timeline";
import "@/components/records/records.css";

export const metadata: Metadata = { title: "Your record | Wild Hearts Health" };

type Params = Record<string, string | string[] | undefined>;

async function HomeRecords({ userId, params }: { userId: string; params: Params }) {
  const allSources = await loadSourcesFor(userId);
  const filters = parseFilters(params, allSources);
  const cursor = parseCursor(params.before);
  const { sources, items, related, next, problems } = await loadTimelineFor(userId, filters, cursor);
  const counts = countsFor(sources, filters);
  const tones = sourceTones(sources);
  return (
    <>
      <ProblemNotices problems={problems} />
      <SyncWatcher active={problems.some((p) => p.kind === "importing")} />
      <ul className="record-summary" aria-label="Record summary">
        {CATEGORIES.filter(({ category }) => counts[category] > 0).map(({ category, label, slug }) => (
          <li key={category}>
            <Link href={`/app/records/${slug}`}>
              <b>{counts[category]}</b> {label}
            </Link>
          </li>
        ))}
      </ul>
      <TimelineFilterForm action="/app" sources={sources} filters={filters} tones={tones} />
      <p className="record-note">Shown as recorded by your health systems. Wild Hearts doesn&apos;t change or interpret it.</p>
      {items.length === 0 ? (
        <p className="lede">{hasFilters(filters) ? "No records match these filters." : "No records yet."}</p>
      ) : (
        <Timeline items={items} related={related} tones={tones} />
      )}
      <TimelinePager path="/app" filters={filters} next={next} paged={cursor !== null} />
    </>
  );
}

export default async function AppHome({ searchParams }: PageProps<"/app">) {
  const { session, profile } = await requireOnboarded();
  const sources = await loadSourcesFor(session.user.id);

  if (sources.length === 0) {
    return (
      <section className="app-page">
        <h1>Welcome, {profile.preferredName}.</h1>
        <div className="empty-record">
          <span className="avatar">
            <FaceMark />
          </span>
          <h2>Your record starts with one connection.</h2>
          <p>Connect a health system and your conditions, medications, results and visits will gather here.</p>
          <Link className="btn btn-lg" href="/app/connections">
            Connect a health system
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="app-page">
      <h1>{profile.preferredName}&apos;s record</h1>
      <p className="lede">
        From {sources.length === 1 ? sources[0].organizationName : `${sources.length} health systems`}, newest first.
      </p>
      <Suspense fallback={<RecordsLoading />}>
        <HomeRecords userId={session.user.id} params={await searchParams} />
      </Suspense>
    </section>
  );
}
