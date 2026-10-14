import { requireSession } from "@/lib/session";
import Link from "next/link";
import { db } from "@/lib/db";
import { recordsKey } from "@/lib/records-keys";
import { listFiles, fileUsage } from "@/lib/wildcards-store";
import { Wildcards } from "./Wildcards";
import "./wildcards.css";
import { r2Configured } from "@/lib/wildcards-r2";

export default async function WildcardsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const session = await requireSession();
  const usage = await fileUsage(db, session.user.id);
  const requested = Number((await searchParams).page);
  const page = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, Math.max(1, Math.ceil(usage.count / 50))) : 1;
  const files = await listFiles(db, recordsKey(), session.user.id, page);
  return <section className="app-page wildcards">
    <h1>Documents</h1>
    <p><Link href="/app/wildcards/workbench">Open extraction workbench →</Link></p>
    <p className="lede">A private place for the files you want to keep with your health record. Only you can access them through your account.</p>
    <Wildcards files={files} usage={usage} page={page} owner={session.user.id} available={r2Configured()} />
  </section>;
}
