"use client";

import { useActionState } from "react";
import { finishOnboardingAction, type FormState } from "./actions";

// Plan 03 replaces this with the health-system search.
export function ConnectStep() {
  const [, action, pending] = useActionState<FormState, FormData>(finishOnboardingAction, {});
  return (
    <form className="auth-form" action={action}>
      <p className="form-notice">You&apos;ll be able to connect a health system from your dashboard.</p>
      <button className="btn btn-lg" type="submit" disabled={pending}>
        Go to my dashboard
      </button>
    </form>
  );
}
