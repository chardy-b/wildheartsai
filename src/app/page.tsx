import { Closing } from "@/components/landing/Closing";
import { Footer } from "@/components/landing/Footer";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Nav } from "@/components/landing/Nav";
import { Privacy } from "@/components/landing/Privacy";
import { Specialist } from "@/components/landing/Specialist";
import { Understanding } from "@/components/landing/Understanding";
import "@/components/landing/landing.css";

export default function Home() {
  return (
    <div className="landing">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Nav />
      <main id="main-content">
        <Hero />
        <HowItWorks />
        <Understanding />
        <Specialist />
        <Privacy />
        <Closing />
      </main>
      <Footer />
    </div>
  );
}
