import type { Metadata } from "next";
import { requireOnboarded } from "@/lib/onboarding-guard";

export const metadata: Metadata = { title: "Your record | Wild Hearts Health" };

export default async function AppHome() {
  const { profile } = await requireOnboarded();
  return (
    <section className="app-page">
      <h1>Welcome, {profile.preferredName}.</h1>
      <p className="lede">Your record will gather here once you connect a health system.</p>
    </section>
  );
}
