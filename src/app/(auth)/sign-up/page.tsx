import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/AuthCard";
import { CONTACT_HREF } from "@/components/landing/contact";
import { env } from "@/lib/env";
import { SignUpForm } from "./SignUpForm";

export const metadata: Metadata = { title: "Create an account | Wild Hearts Health" };

// SIGNUPS_ENABLED is read per request so flipping it in Vercel takes effect without a rebuild.
export const dynamic = "force-dynamic";

export default function SignUpPage() {
  if (!env().SIGNUPS_ENABLED) {
    return (
      <AuthCard
        title="Early access is by invitation."
        lede="We're letting people in slowly. Tell us a little about your care and we'll be in touch."
      >
        <a className="btn btn-lg" href={CONTACT_HREF}>
          Share your interest
        </a>
        <p className="auth-links">
          <Link href="/sign-in">Already invited? Sign in</Link>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Create your account." lede="You'll confirm your email, then connect your first health system.">
      <SignUpForm />
      <p className="auth-links">
        <Link href="/sign-in">Already have an account? Sign in</Link>
      </p>
    </AuthCard>
  );
}
