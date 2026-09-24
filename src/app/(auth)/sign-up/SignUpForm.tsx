"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-errors";

export function SignUpForm({ inviteRequired }: { inviteRequired: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { error } = await authClient.signUp.email({
      name: String(form.get("name")).trim(),
      email: String(form.get("email")),
      password: String(form.get("password")),
      callbackURL: "/app",
      ...(inviteRequired ? { inviteCode: String(form.get("inviteCode")) } : {}),
    });
    setPending(false);
    if (error) {
      setError(authErrorMessage(error));
      return;
    }
    router.push("/check-email");
  }

  return (
    <form className="auth-form" onSubmit={onSubmit}>
      {inviteRequired ? (
        <label className="field">
          Invite code
          <input name="inviteCode" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} required />
        </label>
      ) : null}
      <label className="field">
        What should we call you?
        <input name="name" type="text" autoComplete="given-name" maxLength={60} required />
      </label>
      <label className="field">
        Email
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label className="field">
        Password
        <input name="password" type="password" autoComplete="new-password" minLength={12} required />
        <span className="field-hint">At least 12 characters.</span>
      </label>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="btn btn-lg" type="submit" disabled={pending}>
        {pending ? "Creating your account" : "Create account"}
      </button>
    </form>
  );
}
