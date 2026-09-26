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
    database: drizzleAdapter(db, { provider: "sqlite" }),
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
    hooks: { before: inviteGate(env().SIGNUP_INVITE_CODE) },
    // Cloudflare sets cf-connecting-ip to the visitor's address and overwrites any value the
    // client sends, so rate limits count per visitor rather than in one shared bucket.
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    plugins: [nextCookies()],
  });
}

// Built on first use so `next build` can load routes without runtime secrets.
export const auth = lazy(createAuth);
