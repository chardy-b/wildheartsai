import { AppNav } from "@/components/app/AppNav";
import { requireSession } from "@/lib/session";
import "@/components/app/app.css";

const LINKS = [
  { href: "/app", label: "Your record" },
  { href: "/app/connections", label: "Connections" },
];

export default async function AppLayout({ children }: LayoutProps<"/app">) {
  await requireSession();
  return (
    <div className="app-shell">
      <AppNav links={LINKS} />
      <main className="wrap app-main" id="main-content">
        {children}
      </main>
      <footer className="wrap app-footer">
        Wild Hearts Health is not a medical provider and does not give medical advice.
      </footer>
    </div>
  );
}
