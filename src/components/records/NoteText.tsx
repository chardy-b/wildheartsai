"use client";

import { useState, useTransition } from "react";
import { showNoteAction } from "@/app/(app)/app/records/actions";
import type { NoteResult } from "@/lib/records-notes";

const MESSAGES: Record<Exclude<NoteResult, { ok: true }>["reason"], string> = {
  not_found: "We couldn't find this note.",
  unsupported: "This document isn't text we can show here. You can open it in MyChart.",
  reconnect: "This health system needs you to sign in again before we can load the note.",
  unavailable: "We couldn't load this note just now. Try again in a moment.",
};

// Loads a note's text when asked. The server returns plain text only, shown as text.
export function NoteText({ connectionId, attachmentUrl }: { connectionId: string; attachmentUrl: string }) {
  const [result, setResult] = useState<NoteResult | null>(null);
  const [pending, startTransition] = useTransition();

  if (result?.ok) return <div className="note-text">{result.text}</div>;
  return (
    <div className="note-load">
      <button
        className="btn btn-ghost"
        type="button"
        disabled={pending}
        onClick={() => startTransition(async () => setResult(await showNoteAction(connectionId, attachmentUrl)))}
      >
        {pending ? "Loading note" : "Show note"}
      </button>
      {result && !result.ok ? (
        <p className="note-error" role="status">
          {MESSAGES[result.reason]}
        </p>
      ) : null}
    </div>
  );
}
