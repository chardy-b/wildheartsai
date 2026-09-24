import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/lib/auth";

// Read the request headers before touching `auth`: that marks the page as dynamic,
// so Next never tries to prerender it (and never needs auth's secrets at build time).
export const getSession = cache(async () => {
  const requestHeaders = await headers();
  return auth.api.getSession({ headers: requestHeaders });
});

export type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return session;
}
