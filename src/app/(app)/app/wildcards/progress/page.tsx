import Link from "next/link";
import { requireSession } from "@/lib/session";
import { backend } from "@/lib/backend";
import { Progress } from "./Progress";
import "../wildcards.css";

export default async function ProgressPage() {
  const session = await requireSession();
  const files = await (await backend()).readyDocuments(session.user.id);
  return <section className="app-page wildcards"><Link href="/app/wildcards">← Documents</Link><h1>Document processing</h1><Progress files={files} /></section>;
}
