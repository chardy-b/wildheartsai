import { requireSession } from "@/lib/session";
import Link from "next/link";
import { backend } from "@/lib/backend";
import { Wildcards } from "./Wildcards";
import "./wildcards.css";

export default async function WildcardsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const session = await requireSession();
  const data = await backend();
  const { files, usage, page } = await data.documents(session.user.id, Number((await searchParams).page));
  return <section className="app-page wildcards">
    <h1>Documents</h1>
    <p><Link href="/app/wildcards/progress">View processing progress →</Link> · <Link href="/app/wildcards/workbench">Extraction workbench →</Link> · <Link href="/app/wildcards/benchmark">Quality report →</Link></p>
    <p className="lede">A private place for the files you want to keep with your health record. Only you can access them through your account.</p>
    <Wildcards files={files} usage={usage} page={page} owner={session.user.id} available={data.documentsAvailable()} />
  </section>;
}
