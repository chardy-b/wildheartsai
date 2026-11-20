import { createHash } from "node:crypto";
import { DEMO_USER_ID } from "./scenario";
import { DEMO_MODE_COOKIE } from "./cookies";
export { DEMO_GUEST_COOKIE, DEMO_MODE_COOKIE } from "./cookies";

const PREFIX = "wildhearts_demo_workspace_";
export function demoUserId(ownerId: string): string {
  if (!ownerId || isDemoIdentity(ownerId)) throw new Error("invalid_demo_owner");
  return `${PREFIX}${createHash("sha256").update(ownerId).digest("hex")}`;
}
export function isDemoIdentity(userId: string): boolean {
  return userId === DEMO_USER_ID || /^wildhearts_demo_workspace_[a-f0-9]{64}$/.test(userId) || isGuestDemoIdentity(userId);
}

// A visitor without an account (Cloudflare only): a short-lived fictional workspace of its own,
// reached by a cookie of its own, never by a Better Auth login.
export const DEMO_GUEST_PREFIX = "wildhearts_demo_guest_";
export function isGuestDemoIdentity(userId: string): boolean {
  return /^wildhearts_demo_guest_[a-f0-9]{64}$/.test(userId);
}

export function demoModeValue(sessionId: string): string {
  return createHash("sha256").update(`demo-mode:${sessionId}`).digest("hex");
}
export function demoSelected(requestHeaders: Headers, sessionId: string): boolean {
  // Disabling demo entry must never switch an already-open chat to personal data.
  const value = requestHeaders.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(`${DEMO_MODE_COOKIE}=`))?.slice(DEMO_MODE_COOKIE.length + 1);
  return value === demoModeValue(sessionId);
}
