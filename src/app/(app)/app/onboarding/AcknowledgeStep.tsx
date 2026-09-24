"use client";

import { useActionState } from "react";
import { ACKNOWLEDGEMENTS } from "@/lib/onboarding";
import { acknowledgeAction, type FormState } from "./actions";

export function AcknowledgeStep() {
  const [state, action, pending] = useActionState<FormState, FormData>(acknowledgeAction, {});
  return (
    <form className="auth-form" action={action}>
      <fieldset className="ack-list">
        <legend className="visually-hidden">Before you connect</legend>
        {ACKNOWLEDGEMENTS.map((item) => (
          <label className="ack" key={item.id}>
            <input type="checkbox" name={item.id} required />
            <span>
              {item.text}
              {item.link ? (
                <>
                  {" "}
                  <a href={item.link.href} target="_blank" rel="noreferrer">
                    {item.link.label}
                  </a>
                </>
              ) : null}
            </span>
          </label>
        ))}
      </fieldset>
      {state.error ? (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button className="btn btn-lg" type="submit" disabled={pending}>
        I understand
      </button>
    </form>
  );
}
