import Link from "next/link";
import { requireSession } from "@/lib/session";
import { db } from "@/lib/db";
import { recordsKey } from "@/lib/records-keys";
import { listFiles, fileUsage } from "@/lib/wildcards-store";
import { Progress } from "./Progress";
import "../wildcards.css";

export default async function ProgressPage() {
  const session = await requireSession(), usage = await fileUsage(db, session.user.id), files = [];
  for (let page = 1; page <= Math.ceil(usage.count / 50); page++) files.push(...await listFiles(db, recordsKey(), session.user.id, page));
  return <section className="app-page wildcards"><Link href="/app/wildcards">← Documents</Link><h1>Document processing</h1><Progress files={files.filter(f => f.status === "ready")} /></section>;
}
