import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Pre-launch privacy notice | Wild Hearts Health",
  description:
    "What the current Wild Hearts Health concept site does and does not collect.",
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto min-h-screen w-[min(720px,calc(100%-32px))] py-12 sm:py-20">
      <Link
        className="font-bold text-rasp-text underline decoration-2 underline-offset-4"
        href="/"
      >
        ← Wild Hearts Health
      </Link>

      <div className="mt-12 space-y-12">
        <header className="space-y-5">
          <p className="text-sm font-bold uppercase tracking-[0.18em] text-rasp-text">
            Pre-launch privacy notice
          </p>
          <h1 className="max-w-[14ch] text-5xl font-extrabold leading-tight sm:text-6xl">
            This is a concept site, not a health-record service.
          </h1>
          <p className="max-w-[62ch] text-xl text-text-2">
            Wild Hearts Health is still in development. The current site does
            not offer accounts, connect to MyChart or Epic, or accept medical
            records.
          </p>
        </header>

        <section className="space-y-3" aria-labelledby="current-site">
          <h2 id="current-site" className="text-3xl font-bold">
            The current site
          </h2>
          <p className="text-text-2">
            This repository does not configure analytics, advertising trackers,
            patient accounts, health-record connections or health-data storage.
            Like most hosted websites, the hosting provider may process basic
            request information needed to serve and protect the site.
          </p>
        </section>

        <section className="space-y-3" aria-labelledby="email-contact">
          <h2 id="email-contact" className="text-3xl font-bold">
            Email contact
          </h2>
          <p className="text-text-2">
            The “Share your interest” links open your email application. Please
            do not send medical records, account credentials or other private
            health information. Email is for general product feedback and
            research interest only.
          </p>
        </section>

        <section className="space-y-3" aria-labelledby="future-product">
          <h2 id="future-product" className="text-3xl font-bold">
            Before any record connection
          </h2>
          <p className="text-text-2">
            A future product would need a reviewed privacy policy, clear consent
            and revocation controls, a defined retention schedule, appropriate
            security safeguards and an evidence-backed legal and compliance
            assessment. The design principles on the homepage describe that
            intended direction, not a live service.
          </p>
        </section>

        <section className="space-y-3" aria-labelledby="contact">
          <h2 id="contact" className="text-3xl font-bold">
            Questions
          </h2>
          <p className="text-text-2">
            For non-sensitive questions, email{" "}
            <a
              className="font-bold text-rasp-text underline decoration-2 underline-offset-4"
              href="mailto:teo@wildheartsai.com?subject=Wild%20Hearts%20Health%20privacy"
            >
              teo@wildheartsai.com
            </a>
            .
          </p>
        </section>
      </div>
    </main>
  );
}
