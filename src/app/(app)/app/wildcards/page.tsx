import { requireSession } from "@/lib/session";
import { db } from "@/lib/db";
import { recordsKey } from "@/lib/records-keys";
import { listFiles } from "@/lib/wildcards-store";
import { Wildcards } from "./Wildcards";
import "./wildcards.css";
import { r2Configured } from "@/lib/wildcards-r2";

export default async function WildcardsPage() {
  const session = await requireSession();
  const files = await listFiles(db, recordsKey(), session.user.id);
  return <section className="app-page wildcards">
    <h1>Documents</h1>
    <p className="lede">A private place for the files you want to keep with your health record. Only you can access them through your account.</p>
    <Wildcards files={files} available={r2Configured()} />
  </section>;
}
