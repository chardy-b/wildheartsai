import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FaceMark } from "@/components/landing/marks";
import { ProblemNotices } from "@/components/records/ProblemNotices";
import { RecordsLoading } from "@/components/records/RecordsLoading";
import { Timeline } from "@/components/records/Timeline";
import { db } from "@/lib/db";
import { listConnections } from "@/lib/epic/connections";
import { CATEGORIES } from "@/lib/fhir/categories";
import { requireOnboarded } from "@/lib/onboarding-guard";
import { countByCategory } from "@/lib/records";
import { loadRecordsFor } from "@/lib/records-server";
import "@/components/records/records.css";

export const metadata: Metadata = { title: "Your record | Wild Hearts Health" };

const TIMELINE_LIMIT = 60;

async function HomeRecords({ userId }: { userId: string }) {
  const { items, problems } = await loadRecordsFor(userId);
  const counts = countByCategory(items);
  return (
    <>
      <ProblemNotices problems={problems} />
      <ul className="record-summary" aria-label="Record summary">
        {CATEGORIES.filter(({ category }) => counts[category] > 0).map(({ category, label, slug }) => (
          <li key={category}>
            <Link href={`/app/records/${slug}`}>
              <b>{counts[category]}</b> {label}
            </Link>
          </li>
        ))}
      </ul>
      <p className="record-note">Shown as recorded by your health systems. Wild Hearts doesn&apos;t change or interpret it.</p>
      <Timeline items={items.filter((item) => item.date).slice(0, TIMELINE_LIMIT)} related={items} />
    </>
  );
}

export default async function AppHome() {
  const { session, profile } = await requireOnboarded();
  const connections = await listConnections(db, session.user.id);

  if (connections.length === 0) {
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
        From {connections.length === 1 ? connections[0].organizationName : `${connections.length} health systems`}, newest first.
      </p>
      <Suspense fallback={<RecordsLoading />}>
        <HomeRecords userId={session.user.id} />
      </Suspense>
    </section>
  );
}
