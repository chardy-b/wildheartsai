import "server-only";
import { auth } from "@/lib/auth";
import { DEMO_MODE_COOKIE, demoSelected } from "@/lib/demo/identity";

/** Auth always validates the real login first. The cookie only selects its workspace. */
export async function applicationSession(requestHeaders: Headers) {
  const identity = await auth.api.getSession({ headers: requestHeaders, query: { disableRefresh: true } });
  if (!identity || !requestHeaders.get("cookie")?.includes(`${DEMO_MODE_COOKIE}=`) || !demoSelected(requestHeaders, identity.session.id)) return identity;
  const [{ db }, { selectedDemoSession }] = await Promise.all([import("@/lib/db"), import("@/lib/demo/workspace")]);
  // A missing or revoked workspace cannot fall back to querying personal records.
  return selectedDemoSession(db, identity);
}
