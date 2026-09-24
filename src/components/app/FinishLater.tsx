"use client";

import { useActionState } from "react";
import { finishOnboardingAction, type FormState } from "@/app/(app)/app/onboarding/actions";

export function FinishLater() {
  const [, action, pending] = useActionState<FormState, FormData>(finishOnboardingAction, {});
  return (
    <form action={action}>
      <button className="btn btn-ghost" type="submit" disabled={pending}>
        I&apos;ll do this later
      </button>
    </form>
  );
}
