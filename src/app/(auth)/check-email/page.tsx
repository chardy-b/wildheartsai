import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/AuthCard";

export const metadata: Metadata = { title: "Check your email | Wild Hearts Health" };

export default function CheckEmailPage() {
  return (
    <AuthCard
      title="Check your email."
      lede="We sent a link to confirm your address. Open it on this device to finish signing up."
    >
      <p className="auth-links">
        <Link href="/sign-in">Back to sign in</Link>
      </p>
    </AuthCard>
  );
}
