import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/AuthCard";
import { ResetPasswordForm } from "./ResetPasswordForm";

export const metadata: Metadata = { title: "Choose a new password | Wild Hearts Health" };

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const { token, error } = await searchParams;

  if (error || typeof token !== "string") {
    return (
      <AuthCard title="That link has expired." lede="Reset links work once and last an hour. Ask for a new one.">
        <Link className="btn btn-lg" href="/forgot-password">
          Send a new link
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password.">
      <ResetPasswordForm token={token} />
    </AuthCard>
  );
}
