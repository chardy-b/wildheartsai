import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/AuthCard";
import { isDemoUser } from "@/lib/demo/access";
import { getSession, getRealSession } from "@/lib/session";
import { SignInForm } from "../sign-in/SignInForm";
import { enterDemo } from "./actions";

export const metadata: Metadata = {
  title: "Demo | Wild Hearts Health",
  description: "Explore a fictional patient story with connected records, source-linked answers, document uploads and visit preparation.",
  robots: { index: false, follow: false },
};

export default async function DemoEntryPage() {
  if (process.env.DEMO_ENABLED !== "1") notFound();

  const session = await getRealSession();
  const selected = session?.user.emailVerified ? await getSession() : null;
  if (selected && isDemoUser(selected.user.id)) redirect("/app/demo");

  return (
    <AuthCard title="One patient. The whole story." lede="Meet Alex, a fictional patient whose care is scattered across three clinics. Explore the records, ask Holo, add a sample PDF and prepare for the next visit.">
      {session?.user.emailVerified ? <>
        <p className="form-notice">You’re signed in. Your demo has its own fictional chart and chat history, separate from your personal records.</p>
        <form action={enterDemo} className="auth-form"><button className="btn btn-lg" type="submit">Open guided demo</button></form>
      </> : <SignInForm destination="/demo" submitLabel="Sign in to open demo" notice="Use your usual Wild Hearts account. No separate demo login is needed." />}
      <p className="auth-links">
        {!session?.user.emailVerified && <Link href="/forgot-password">Forgot your password?</Link>}
        <Link href="/app">Back to your account</Link>
      </p>
    </AuthCard>
  );
}
