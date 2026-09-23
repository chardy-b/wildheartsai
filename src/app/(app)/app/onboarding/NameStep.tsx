"use client";

import { useActionState } from "react";
import { saveNameAction, type FormState } from "./actions";

export function NameStep({ defaultName }: { defaultName: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveNameAction, {});
  return (
    <form className="auth-form" action={action}>
      <label className="field">
        Your name
        <input name="preferredName" type="text" defaultValue={defaultName} maxLength={60} autoComplete="given-name" required />
        <span className="field-hint">It doesn&apos;t need to match your medical record.</span>
      </label>
      {state.error ? (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button className="btn btn-lg" type="submit" disabled={pending}>
        Continue
      </button>
    </form>
  );
}
