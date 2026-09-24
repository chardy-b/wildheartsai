import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/AuthCard";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = { title: "Sign in | Wild Hearts Health" };

const NOTICES: Record<string, string> = {
  reset: "Your password is updated. Sign in with the new one.",
};

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { notice } = await searchParams;
  return (
    <AuthCard title="Welcome back." lede="Sign in to see your record.">
      <SignInForm notice={typeof notice === "string" ? NOTICES[notice] : undefined} />
      <p className="auth-links">
        <Link href="/forgot-password">Forgot your password?</Link>
        <Link href="/sign-up">Create an account</Link>
      </p>
    </AuthCard>
  );
}
