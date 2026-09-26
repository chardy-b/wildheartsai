import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Privacy notice | Wild Hearts Health",
  description: "What Wild Hearts Health stores, what it doesn't, and the choices you have.",
};

const linkClass = "font-bold text-rasp-text underline decoration-2 underline-offset-4";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="space-y-3" aria-labelledby={id}>
      <h2 id={id} className="text-3xl font-bold">
        {title}
      </h2>
      <div className="space-y-3 text-text-2">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <main className="mx-auto min-h-screen w-[min(720px,calc(100%-32px))] py-12 sm:py-20">
      <Link className={linkClass} href="/">
        ← Wild Hearts Health
      </Link>

      <div className="mt-12 space-y-12">
        <header className="space-y-5">
          <p className="text-sm font-bold uppercase tracking-[0.18em] text-rasp-text">Privacy notice</p>
          <h1 className="max-w-[16ch] text-5xl font-extrabold leading-tight sm:text-6xl">
            What we keep, and what we don&apos;t.
          </h1>
          <p className="max-w-[62ch] text-xl text-text-2">
            Wild Hearts Health gathers the records you choose from your health systems so you can see them in one
            place. This notice explains what that involves. Last updated September 26, 2026.
          </p>
        </header>

        <Section id="what-we-store" title="What we store">
          <ul className="list-disc space-y-2 pl-6">
            <li>
              <strong>Your account:</strong> the name you give us, your email address, and your password, stored as
              a one-way hash we can&apos;t read.
            </li>
            <li>
              <strong>Your sign-ins:</strong> when each session started and ends, and the IP address and browser
              details sent when you signed in. We use these to keep you signed in and to spot misuse.
            </li>
            <li>
              <strong>Your setup:</strong> what you&apos;d like us to call you, and when you confirmed the notices
              during setup.
            </li>
            <li>
              <strong>Your connections:</strong> for each health system you connect, its name and address, the
              access it grants us (a list of permissions, plus the access and refresh tokens that carry them), and
              your patient ID there. The tokens and patient ID are encrypted before they&apos;re saved.
            </li>
            <li>
              <strong>Your health records:</strong> a copy of the records each connected health system shares with
              us, and when we last checked for new ones. See below.
            </li>
          </ul>
        </Section>

        <Section id="health-records" title="Your health records">
          <p>
            When you connect a health system, we import the records it shares and keep a copy in our database, so
            your dashboard loads quickly and shows your full history. We check for new and changed records when you
            press Refresh. When a record changes, we keep the earlier
            version too, marked as replaced. We don&apos;t write your records to our logs.
          </p>
          <p>
            Wild Hearts shows the parts of your record your health systems share through MyChart: conditions,
            medications and pharmacy fills, allergies, lab results and reports (including imaging reports), vital
            signs, immunizations, visits and their notes, procedures, orders, your care team, care plans, goals,
            social history, implanted devices and insurance. We only request those. A note&apos;s text is fetched from
            your health system when you open it, and isn&apos;t stored.
          </p>
          <p>
            Wild Hearts Health is not a medical provider and does not give medical advice. Records appear as your
            health systems recorded them.
          </p>
        </Section>

        <Section id="what-we-dont-do" title="What we don't do">
          <p>
            We don&apos;t sell your information, show ads, or use analytics or advertising trackers. We don&apos;t
            share your information with anyone except the services below, which we use to run Wild Hearts.
          </p>
        </Section>

        <Section id="services" title="Services we use">
          <ul className="list-disc space-y-2 pl-6">
            <li>
              <strong>Vercel</strong> hosts the site and keeps short-lived request logs.
            </li>
            <li>
              <strong>Inngest</strong> schedules the background work that imports your records. It only receives
              internal ID numbers, never your records or your health-system access.
            </li>
            <li>
              <strong>Neon</strong> hosts our database.
            </li>
            <li>
              <strong>Google Workspace</strong> sends our emails, such as confirming your address or resetting your
              password.
            </li>
            <li>
              <strong>Epic and your health systems</strong> provide your records when you connect them and when you
              refresh, using the access you approved in MyChart.
            </li>
          </ul>
        </Section>

        <Section id="cookies" title="Cookies">
          <p>
            We use one cookie to keep you signed in, and a second that lasts 10 minutes while you connect a health
            system. We don&apos;t use tracking cookies.
          </p>
        </Section>

        <Section id="security" title="Security">
          <p>
            Everything travels over encrypted connections. Health-system tokens and patient IDs are encrypted in our
            database. Your health records are encrypted with a key that belongs to your account alone, so records
            can&apos;t be read without it, and deleting your account deletes the key. Passwords are stored only as
            hashes, and new accounts confirm their email address before they can sign in.
          </p>
        </Section>

        <Section id="choices" title="Your choices">
          <p>
            You can disconnect a health system at any time from Connections. That deletes the tokens and patient ID
            we stored for it and keeps the records already imported, so your history stays in one place. You can
            delete those records from Connections too. You can also remove Wild Hearts from the list of apps in your
            MyChart account.
          </p>
          <p>
            To delete your account, email us from the address on your account and we&apos;ll delete it along with
            your setup, connections and every record we imported.
          </p>
        </Section>

        <Section id="changes" title="Changes">
          <p>
            If we change what we collect or how we use it, we&apos;ll update this page and ask you to confirm again
            before you continue.
          </p>
        </Section>

        <Section id="contact" title="Questions">
          <p>
            Email{" "}
            <a className={linkClass} href="mailto:teo@wildheartsai.com?subject=Wild%20Hearts%20Health%20privacy">
              teo@wildheartsai.com
            </a>
            . Please don&apos;t email medical records or other private health information.
          </p>
        </Section>
      </div>
    </main>
  );
}
