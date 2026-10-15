import Link from "next/link";
import { requireSession } from "@/lib/session";
import { db } from "@/lib/db";
import { recordsKey } from "@/lib/records-keys";
import { listFiles, fileUsage } from "@/lib/wildcards-store";
import { Workbench } from "./Workbench";
import "../wildcards.css";
import "./workbench.css";

export default async function WorkbenchPage({ searchParams }: { searchParams: Promise<{ fileId?: string }> }) {
  const session = await requireSession();
  const usage = await fileUsage(db, session.user.id);
  const files = [];
  for (let page = 1; page <= Math.ceil(usage.count / 50); page++) files.push(...await listFiles(db, recordsKey(), session.user.id, page));
  return <section className="app-page wildcards"><Link href="/app/wildcards">← Documents</Link><h1>Extraction workbench</h1>
    <p className="lede">Compare local parsers, inspect evidence, and measure extraction and redaction against reviewed reference labels.</p>
    <Workbench files={files.filter(f => f.status === "ready")} initialFileId={(await searchParams).fileId} />
  </section>;
}
