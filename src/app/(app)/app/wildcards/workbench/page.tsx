import Link from "next/link";
import { requireSession } from "@/lib/session";
import { backend } from "@/lib/backend";
import { Workbench } from "./Workbench";
import "../wildcards.css";
import "./workbench.css";

export default async function WorkbenchPage({ searchParams }: { searchParams: Promise<{ fileId?: string }> }) {
  const session = await requireSession();
  const files = await (await backend()).readyDocuments(session.user.id);
  return <section className="app-page wildcards"><Link href="/app/wildcards">← Documents</Link><h1>Extraction workbench</h1>
    <p className="lede">Compare local parsers, inspect evidence, and measure extraction and redaction against reviewed reference labels.</p>
    <Workbench files={files} initialFileId={(await searchParams).fileId} />
  </section>;
}
