import { z } from "zod";

// The API Worker's configuration: bindings from wrangler.jsonc, secrets from `wrangler secret put`
// (per environment), and non-secret flags as vars. Ported from src/lib/env.ts in the Next app,
// without the settings Cloudflare bindings replace (DATABASE_URL, R2_* credentials) or Vercel
// provides (VERCEL_URL). Secrets stay server-only: the web Worker gets none of them.

export type Bindings = {
  DB: D1Database;
  FILES: R2Bucket;
  APP_ENV: "development" | "preview" | "production";
} & Partial<Record<keyof z.input<typeof secretsSchema>, string>>;

const flag = z.enum(["true", "false"]).default("false").transform((value) => value === "true");
const key32 = (name: string) =>
  z.string().refine((value) => Buffer.from(value, "base64").length === 32, `${name} must be 32 bytes, base64-encoded`);

const secretsSchema = z
  .object({
    BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
    // The public origin. Required: Workers have no per-deployment URL fallback like VERCEL_URL.
    BETTER_AUTH_URL: z.url(),
    EMAIL_FROM: z.string().min(3),
    // Preview only: print verification and reset links to the Worker's logs (see src/auth/email.ts).
    EMAIL_LOG_LINKS: flag,
    // When set, sign-up also needs this early-access invite code.
    SIGNUP_INVITE_CODE: z.string().min(1).optional(),
    SIGNUPS_ENABLED: flag,
    // sandbox: only Epic's sandbox is offered. production: real health systems, plus the sandbox.
    EPIC_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
    // Separate fail-closed rollout switch for production health systems.
    EPIC_PRODUCTION_ACCESS_ENABLED: flag,
    EPIC_EXPANDED_SCOPES: flag,
    EPIC_CLIENT_ID: z.string().min(1),
    EPIC_REDIRECT_URI: z.url(),
    EPIC_PRIVATE_JWK: z.string().min(2),
    EPIC_RETIRING_PUBLIC_JWK: z.string().min(2).optional(),
    EPIC_PRODUCTION_CLIENT_ID: z.string().min(1).optional(),
    EPIC_PRODUCTION_PRIVATE_JWK: z.string().min(2).optional(),
    EPIC_PRODUCTION_RETIRING_PUBLIC_JWK: z.string().min(2).optional(),
    METRIPORT_API_KEY: z.string().min(1).optional(),
    TOKEN_ENCRYPTION_KEY: key32("TOKEN_ENCRYPTION_KEY"),
    // Key-encryption key for stored health records. Must differ from TOKEN_ENCRYPTION_KEY.
    RECORDS_ENCRYPTION_KEY: key32("RECORDS_ENCRYPTION_KEY"),
  })
  .superRefine((value, ctx) => {
    if (value.RECORDS_ENCRYPTION_KEY === value.TOKEN_ENCRYPTION_KEY) {
      ctx.addIssue({ code: "custom", path: ["RECORDS_ENCRYPTION_KEY"], message: "RECORDS_ENCRYPTION_KEY must differ from TOKEN_ENCRYPTION_KEY" });
    }
    if (value.EPIC_ENVIRONMENT !== "production") return;
    for (const key of ["EPIC_PRODUCTION_CLIENT_ID", "EPIC_PRODUCTION_PRIVATE_JWK"] as const) {
      if (!value[key]) ctx.addIssue({ code: "custom", path: [key], message: `${key} is required when EPIC_ENVIRONMENT=production` });
    }
  });

export type Secrets = z.infer<typeof secretsSchema>;

export function parseSecrets(source: Record<string, unknown>): Secrets {
  // Only string settings; bindings are objects. `KEY=` in .dev.vars loads as "", meaning "not set".
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => typeof value === "string" && value !== ""),
  );
  return secretsSchema.parse(cleaned);
}

// Validated once per env object (one per isolate in production), so a missing or malformed
// secret fails the request that needs it rather than starting half-configured.
const parsed = new WeakMap<object, Secrets>();

export function secrets(env: Bindings): Secrets {
  let value = parsed.get(env);
  if (!value) {
    value = parseSecrets(env);
    parsed.set(env, value);
  }
  return value;
}

export function enabledEpicEnvironment(value: Pick<Secrets, "EPIC_ENVIRONMENT" | "EPIC_PRODUCTION_ACCESS_ENABLED">): "sandbox" | "production" {
  return value.EPIC_ENVIRONMENT === "production" && value.EPIC_PRODUCTION_ACCESS_ENABLED ? "production" : "sandbox";
}
