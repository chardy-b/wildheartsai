import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { passwordResetEmail, verificationEmail } from "@/lib/email-templates";
import { appUrl, env } from "@/lib/env";
import { inviteGate } from "@/lib/invite";
import { lazy } from "@/lib/lazy";

const DAY = 60 * 60 * 24;

export function createAuth() {
  return betterAuth({
    baseURL: appUrl(),
    secret: env().BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "pg" }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !env().SIGNUPS_ENABLED,
      requireEmailVerification: true,
      minPasswordLength: 12,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail(passwordResetEmail({ to: user.email, url }));
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail(verificationEmail({ to: user.email, url }));
      },
    },
    session: { expiresIn: 7 * DAY, updateAge: DAY },
    // On in production only (Better Auth's default). Counted in Postgres rather than in each
    // server instance's memory, so the limits hold across Vercel's instances. Keyed per IP and path.
    rateLimit: {
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        // Password guessing, and invite-code guessing on sign-up.
        "/sign-in/email": { window: 5 * 60, max: 10 },
        "/sign-up/email": { window: 10 * 60, max: 5 },
        // Emails: reset links and verification resends.
        "/request-password-reset": { window: 15 * 60, max: 3 },
        "/send-verification-email": { window: 15 * 60, max: 3 },
        // Read on every page load; not worth a database write each time.
        "/get-session": false,
      },
    },
    hooks: { before: inviteGate(env().SIGNUP_INVITE_CODE) },
    plugins: [nextCookies()],
  });
}

// Built on first use so `next build` can load routes without runtime secrets.
export const auth = lazy(createAuth);
