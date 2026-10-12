import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/lib/auth";

// Read the request headers before touching `auth`: that marks the page as dynamic,
// so Next never tries to prerender it (and never needs auth's secrets at build time).
export const getSession = cache(async () => {
  const requestHeaders = await headers();
  // Page renders cannot set cookies. Let the browser's session check renew both
  // the database session and its cookie together through the auth route handler.
  return auth.api.getSession({ headers: requestHeaders, query: { disableRefresh: true } });
});

export type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return session;
}
