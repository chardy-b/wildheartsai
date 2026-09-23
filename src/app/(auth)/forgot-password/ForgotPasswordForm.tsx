"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    // The response is ignored on purpose: we never reveal whether an account exists.
    await authClient.requestPasswordReset({ email: String(form.get("email")), redirectTo: "/reset-password" });
    setPending(false);
    setSent(true);
  }

  if (sent) {
    return <p className="form-notice">If an account exists for that email, a reset link is on its way.</p>;
  }

  return (
    <form className="auth-form" onSubmit={onSubmit}>
      <label className="field">
        Email
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <button className="btn btn-lg" type="submit" disabled={pending}>
        {pending ? "Sending" : "Send reset link"}
      </button>
    </form>
  );
}
