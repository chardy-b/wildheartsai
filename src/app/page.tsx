import { Closing } from "@/components/landing/Closing";
import { Footer } from "@/components/landing/Footer";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Nav } from "@/components/landing/Nav";
import { Privacy } from "@/components/landing/Privacy";
import { Specialist } from "@/components/landing/Specialist";
import { Understanding } from "@/components/landing/Understanding";
import { SessionRefresh } from "@/components/app/SessionRefresh";
import { getSession } from "@/lib/session";
import "@/components/landing/landing.css";

export default async function Home() {
  const signedIn = Boolean(await getSession());
  return (
    <div className="landing">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {signedIn ? <SessionRefresh /> : null}
      <Nav signedIn={signedIn} />
      <main id="main-content">
        <Hero signedIn={signedIn} />
        <HowItWorks />
        <Understanding />
        <Specialist />
        <Privacy />
        <Closing signedIn={signedIn} />
      </main>
      <Footer />
    </div>
  );
}
