import { AppNav } from "@/components/app/AppNav";
import { SessionRefresh } from "@/components/app/SessionRefresh";
import { requireSession } from "@/lib/session";
import { isDemoIdentity } from "@/lib/demo/identity";
import Link from "next/link";
import { leaveDemo } from "@/app/(auth)/demo/actions";
import { DEMO_USER_ID } from "@/lib/demo/scenario";
import "@/components/app/app.css";

const LINKS = [
  { href: "/app", label: "Your record" },
  { href: "/app/connections", label: "Connections" },
  { href: "/app/wildcards", label: "Documents" },
  { href: "/app/chat", label: "Chat" },
];

export default async function AppLayout({ children }: LayoutProps<"/app">) {
  const session = await requireSession();
  const demo = isDemoIdentity(session.user.id);
  return (
    <div className="app-shell">
      <SessionRefresh />
      <AppNav links={demo ? [{ href: "/app/demo", label: "Guided demo" }, ...LINKS.map(link => link.href === "/app" ? { ...link, href: "/app?view=records" } : link)] : [...LINKS, ...(process.env.DEMO_ENABLED === "1" ? [{ href: "/demo", label: "Demo" }] : [])]} />
      {demo && <div className="wrap" style={{ fontSize: 12, color: "var(--rose)", paddingBlock: 10 }}>Demo mode · All patient data is fictional. <Link href="/app/demo">Return to the guided story →</Link>{session.user.id !== DEMO_USER_ID && <form action={leaveDemo} style={{ display: "inline", marginLeft: 16 }}><button className="btn btn-ghost" type="submit">Return to my account</button></form>}</div>}
      <main className="wrap app-main" id="main-content">
        {children}
      </main>
      <footer className="wrap app-footer">
        Wild Hearts Health is not a medical provider and does not give medical advice.
      </footer>
    </div>
  );
}
