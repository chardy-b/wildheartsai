import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/AuthCard";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

export const metadata: Metadata = { title: "Reset your password | Wild Hearts Health" };

export default function ForgotPasswordPage() {
  return (
    <AuthCard title="Reset your password." lede="We'll email you a link to choose a new one.">
      <ForgotPasswordForm />
      <p className="auth-links">
        <Link href="/sign-in">Back to sign in</Link>
      </p>
    </AuthCard>
  );
}
