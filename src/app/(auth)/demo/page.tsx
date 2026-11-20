import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/AuthCard";
import { isDemoUser } from "@/lib/demo/access";
import { backend } from "@/lib/backend";
import { getSession, getRealSession } from "@/lib/session";
import { SignInForm } from "../sign-in/SignInForm";
import { enterDemo, enterGuestDemo } from "./actions";

export const metadata: Metadata = {
  title: "Demo | Wild Hearts Health",
  description: "Explore a fictional patient story with connected records, source-linked answers, document uploads and visit preparation.",
  robots: { index: false, follow: false },
};

export default async function DemoEntryPage({ searchParams }: PageProps<"/demo">) {
  if (process.env.DEMO_ENABLED !== "1") notFound();

  const session = await getRealSession();
  // A signed-in person's workspace, or a guest's chart: either way, straight back to the story.
  const selected = await getSession();
  if (selected && isDemoUser(selected.user.id)) redirect("/app/demo");
  const guests = (await backend()).guestDemoAvailable();
  const busy = (await searchParams).error === "busy";

  return (
    <AuthCard title="One patient. The whole story." lede="Meet Alex, a fictional patient whose care is scattered across three clinics. Explore the records, ask Holo, add a sample PDF and prepare for the next visit.">
      {session?.user.emailVerified ? <>
        <p className="form-notice">You’re signed in. Your demo has its own fictional chart and chat history, separate from your personal records.</p>
        <form action={enterDemo} className="auth-form"><button className="btn btn-lg" type="submit">Open guided demo</button></form>
      </> : guests ? <>
        {busy && <p className="form-error" role="alert">Too many demos were started from this network in the last hour. Try again later, or sign in.</p>}
        <form action={enterGuestDemo} className="auth-form"><button className="btn btn-lg" type="submit">Open guided demo</button></form>
        <p className="form-notice">No account needed. Your demo chart is fictional and is deleted after a day, or when you leave.</p>
        <details><summary>Have an account? Sign in to keep a demo alongside it.</summary>
          <SignInForm destination="/demo" submitLabel="Sign in to open demo" notice="Use your usual Wild Hearts account. No separate demo login is needed." />
        </details>
      </> : <SignInForm destination="/demo" submitLabel="Sign in to open demo" notice="Use your usual Wild Hearts account. No separate demo login is needed." />}
      <p className="auth-links">
        {!session?.user.emailVerified && <Link href="/forgot-password">Forgot your password?</Link>}
        <Link href="/app">Back to your account</Link>
      </p>
    </AuthCard>
  );
}
