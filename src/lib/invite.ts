import { createHash, timingSafeEqual } from "node:crypto";
import { APIError, createAuthMiddleware } from "better-auth/api";

export const INVITE_CODE_INVALID = "INVITE_CODE_INVALID";

const digest = (value: string) => createHash("sha256").update(value.trim().toLowerCase()).digest();

// Case-insensitive, and compared in constant time so the code can't be guessed a character at a time.
export function inviteCodeMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== "string" || !provided.trim()) return false;
  return timingSafeEqual(digest(expected), digest(provided));
}

// Early access: when SIGNUP_INVITE_CODE is set, email sign-up also needs `inviteCode` in the body.
export function inviteGate(expected: string | undefined) {
  return createAuthMiddleware(async (ctx) => {
    if (!expected || ctx.path !== "/sign-up/email") return;
    const provided = (ctx.body as { inviteCode?: unknown } | undefined)?.inviteCode;
    if (!inviteCodeMatches(expected, provided)) {
      throw new APIError("FORBIDDEN", { code: INVITE_CODE_INVALID, message: "That invite code isn't right." });
    }
  });
}
