"use client";

import { authClient } from "@/lib/auth-client";

export function SessionRefresh() {
  // Fetch on mount, window focus, and hourly while open so Set-Cookie reaches
  // the browser when Better Auth renews the session.
  authClient.useSession();
  return null;
}
