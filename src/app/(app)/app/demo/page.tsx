import { notFound, redirect } from "next/navigation";
import { requireSession } from "@/lib/session";
import { isDemoUser } from "@/lib/demo/access";
import { demoSnapshot } from "@/lib/demo/store";
import { db } from "@/lib/db";
import { recordsKey } from "@/lib/records-keys";
import { DemoWorkspace } from "./DemoWorkspace";
import "./demo.css";

export const metadata = { title: "Guided demo | Wild Hearts Health" };
export default async function DemoPage() {
  const session = await requireSession();
  if (process.env.DEMO_ENABLED !== "1") notFound();
  if (!isDemoUser(session.user.id)) redirect("/demo");
  const snapshot = await demoSnapshot(db, recordsKey(), session.user.id);
  if (!snapshot) return <section className="app-page"><h1>The demo could not load.</h1><p>Return to the demo entry page and try opening it again.</p><a href="/demo">Open the demo →</a></section>;
  return <DemoWorkspace initial={snapshot} />;
}
