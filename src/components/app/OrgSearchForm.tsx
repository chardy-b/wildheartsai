"use client";

import Form from "next/form";
import { useEffect, useId, useRef } from "react";

export function OrgSearchForm({ query, formAction }: { query: string; formAction: string }) {
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composing = useRef(false);
  const submittedQuery = useRef(query.trim());
  const hintId = useId();

  function cancelSearch() {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }

  function scheduleSearch() {
    cancelSearch();
    const value = input.current?.value.trim() ?? "";
    if (composing.current || (value.length > 0 && value.length < 3) || value === submittedQuery.current) return;
    timer.current = setTimeout(() => form.current?.requestSubmit(), 2000);
  }

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  return (
    <>
      <Form
        ref={form}
        className="org-search-form"
        action={formAction}
        replace
        scroll={false}
        role="search"
        onSubmit={() => {
          cancelSearch();
          submittedQuery.current = input.current?.value.trim() ?? "";
        }}
      >
        <label className="field">
          Find your health system
          <input
            ref={input}
            name="q"
            type="search"
            defaultValue={query}
            placeholder="Hospital, clinic or practice name"
            aria-describedby={hintId}
            onChange={scheduleSearch}
            onCompositionStart={() => { composing.current = true; cancelSearch(); }}
            onCompositionEnd={() => { composing.current = false; scheduleSearch(); }}
          />
        </label>
        <button className="btn" type="submit">Search</button>
      </Form>
      <p className="org-note" id={hintId}>Type at least 3 characters. Results update after a 2-second pause, or press Enter to search now.</p>
    </>
  );
}
