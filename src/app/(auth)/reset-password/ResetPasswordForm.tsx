"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-errors";

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { error } = await authClient.resetPassword({ newPassword: String(form.get("password")), token });
    setPending(false);
    if (error) {
      setError(authErrorMessage(error));
      return;
    }
    router.push("/sign-in?notice=reset");
  }

  return (
    <form className="auth-form" onSubmit={onSubmit}>
      <label className="field">
        New password
        <input name="password" type="password" autoComplete="new-password" minLength={12} required />
        <span className="field-hint">At least 12 characters.</span>
      </label>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="btn btn-lg" type="submit" disabled={pending}>
        {pending ? "Saving" : "Save new password"}
      </button>
    </form>
  );
}
