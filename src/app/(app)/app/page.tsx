import type { Metadata } from "next";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Your record | Wild Hearts Health" };

export default async function AppHome() {
  const session = await requireSession();
  return (
    <section className="app-page">
      <h1>Welcome, {session.user.name}.</h1>
      <p className="lede">Your record will gather here once you connect a health system.</p>
    </section>
  );
}
