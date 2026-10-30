import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { database } from "../db";
import { secrets, type Bindings } from "../env";
import { createEmailSender, passwordResetEmail, type SendEmail, verificationEmail } from "./email";
import { inviteGate } from "./invite";

// Better Auth on D1, configured as in the Next app (src/lib/auth.ts) so accounts, password hashes,
// sessions and cookies carry over unchanged. Better Auth reads and writes its own tables (user,
// session, account, verification, rate_limit) and scopes them itself: they're SYSTEM_TABLES in
// src/data/scope.ts. Keep BETTER_AUTH_SECRET the same as on Vercel, or every session ends at cutover.

const DAY = 60 * 60 * 24;

export type AuthDeps = { sendEmail?: SendEmail };

export function createAuth(env: Bindings, deps: AuthDeps = {}) {
  const config = secrets(env);
  const sendEmail = deps.sendEmail ?? createEmailSender({ appEnv: env.APP_ENV, logLinks: config.EMAIL_LOG_LINKS });
  return betterAuth({
    baseURL: config.BETTER_AUTH_URL,
    secret: config.BETTER_AUTH_SECRET,
    database: drizzleAdapter(database(env.DB), { provider: "sqlite" }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !config.SIGNUPS_ENABLED,
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
    // Remember this browser for 90 days; activity renews the window once a day.
    session: { expiresIn: 90 * DAY, updateAge: DAY },
    // Counted in D1, so the limits hold across Worker isolates. Keyed per IP and path. Set
    // explicitly: Better Auth's own default follows NODE_ENV, which Workers don't set.
    rateLimit: {
      enabled: env.APP_ENV !== "development",
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
    hooks: { before: inviteGate(config.SIGNUP_INVITE_CODE) },
    advanced: {
      // Cloudflare sets cf-connecting-ip at its edge, replacing any value a client sends, and the
      // web Worker forwards it unchanged. X-Forwarded-For can be forged by the client.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      useSecureCookies: config.BETTER_AUTH_URL.startsWith("https://"),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

// One instance per env object (one per isolate in production).
const instances = new WeakMap<Bindings, Auth>();

export function authFor(env: Bindings): Auth {
  let auth = instances.get(env);
  if (!auth) {
    auth = createAuth(env);
    instances.set(env, auth);
  }
  return auth;
}
