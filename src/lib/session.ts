import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { backend, type AppSession } from "@/lib/backend";

// Read the request headers before touching the backend: that marks the page as dynamic, so Next
// never tries to prerender it (and never needs secrets at build time). Page renders cannot set
// cookies, so neither read renews the session: the browser's own session check renews the database
// session and its cookie together through the auth route.
export const getSession = cache(async (): Promise<AppSession | null> => {
  const requestHeaders = await headers();
  return (await backend()).session(requestHeaders);
});

// Workspace selection never replaces the person's Better Auth login cookie.
export const getRealSession = cache(async (): Promise<AppSession | null> => {
  const requestHeaders = await headers();
  return (await backend()).realSession(requestHeaders);
});

export type Session = AppSession;

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect(await getRealSession() ? "/demo" : "/sign-in");
  return session;
}
