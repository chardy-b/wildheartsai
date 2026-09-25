import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ProblemNotices } from "@/components/records/ProblemNotices";
import { RecordList } from "@/components/records/RecordList";
import { RecordsLoading } from "@/components/records/RecordsLoading";
import { categoryForSlug, labelFor } from "@/lib/fhir/categories";
import type { RecordCategory } from "@/lib/fhir/normalize";
import { requireOnboarded } from "@/lib/onboarding-guard";
import { loadRecordsFor } from "@/lib/records-server";
import "@/components/records/records.css";

export async function generateMetadata({ params }: PageProps<"/app/records/[category]">): Promise<Metadata> {
  const category = categoryForSlug((await params).category);
  return { title: `${category ? labelFor(category) : "Records"} | Wild Hearts Health` };
}

async function CategoryRecords({ userId, category }: { userId: string; category: RecordCategory }) {
  const { items, problems } = await loadRecordsFor(userId);
  const inCategory = items.filter((item) => item.category === category);
  return (
    <>
      <ProblemNotices problems={problems} />
      {inCategory.length === 0 ? (
        <p className="lede">Nothing here from your connected health systems yet.</p>
      ) : (
        <div className="timeline">
          <RecordList items={inCategory} related={items} />
        </div>
      )}
    </>
  );
}

export default async function CategoryPage({ params }: PageProps<"/app/records/[category]">) {
  // Checked before anything streams, so an unknown category is a real 404.
  const category = categoryForSlug((await params).category);
  if (!category) notFound();

  const { session } = await requireOnboarded();

  return (
    <section className="app-page">
      <p>
        <Link href="/app">← Your record</Link>
      </p>
      <h1>{labelFor(category)}</h1>
      <Suspense fallback={<RecordsLoading />}>
        <CategoryRecords userId={session.user.id} category={category} />
      </Suspense>
      <p className="record-note">Shown as recorded by your health systems. Wild Hearts doesn&apos;t change or interpret it.</p>
    </section>
  );
}
