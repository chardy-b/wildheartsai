import { z } from "zod";

const schema = z
  .object({
    DATABASE_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
    BETTER_AUTH_URL: z.url().optional(),
    VERCEL_URL: z.string().optional(),
    EMAIL_FROM: z.string().min(3),
    // Google Workspace mailbox that sends verification and reset emails (see src/lib/email.ts).
    SMTP_USER: z.email().optional(),
    SMTP_PASS: z.string().min(1).optional(),
    // When set, sign-up also needs this early-access invite code (see src/lib/invite.ts).
    SIGNUP_INVITE_CODE: z.string().min(1).optional(),
    SIGNUPS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // sandbox: only Epic's sandbox is offered. production: real health systems, plus the sandbox as sample data.
    EPIC_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
    // Separate fail-closed rollout switch. Production endpoints remain unavailable until readiness review is complete.
    EPIC_PRODUCTION_ACCESS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // Non-production client (Epic's sandbox), published at /api/epic/jwks.
    EPIC_CLIENT_ID: z.string().min(1),
    EPIC_REDIRECT_URI: z.url(),
    EPIC_PRIVATE_JWK: z.string().min(2),
    EPIC_RETIRING_PUBLIC_JWK: z.string().min(2).optional(),
    // Production client (real health systems), published at /api/epic/jwks/production.
    EPIC_PRODUCTION_CLIENT_ID: z.string().min(1).optional(),
    EPIC_PRODUCTION_PRIVATE_JWK: z.string().min(2).optional(),
    EPIC_PRODUCTION_RETIRING_PUBLIC_JWK: z.string().min(2).optional(),
    TOKEN_ENCRYPTION_KEY: z
      .string()
      .refine((value) => Buffer.from(value, "base64").length === 32, "TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded"),
  })
  .superRefine((value, ctx) => {
    if (value.EPIC_ENVIRONMENT !== "production") return;
    for (const key of ["EPIC_PRODUCTION_CLIENT_ID", "EPIC_PRODUCTION_PRIVATE_JWK"] as const) {
      if (!value[key]) ctx.addIssue({ code: "custom", path: [key], message: `${key} is required when EPIC_ENVIRONMENT=production` });
    }
  });

export type ServerEnv = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined>): ServerEnv {
  // `KEY=` lines (as in .env.example) load as "", which should mean "not set".
  const cleaned = Object.fromEntries(Object.entries(source).map(([key, value]) => [key, value === "" ? undefined : value]));
  return schema.parse(cleaned);
}

export function enabledEpicEnvironment(
  value: Pick<ServerEnv, "EPIC_ENVIRONMENT" | "EPIC_PRODUCTION_ACCESS_ENABLED">,
): "sandbox" | "production" {
  return value.EPIC_ENVIRONMENT === "production" && value.EPIC_PRODUCTION_ACCESS_ENABLED ? "production" : "sandbox";
}

let cached: ServerEnv | undefined;

export function env(): ServerEnv {
  cached ??= parseEnv(process.env);
  return cached;
}

// The public origin of this deployment. Preview deployments on Vercel have no
// fixed domain, so fall back to the per-deployment URL Vercel provides.
export function resolveAppUrl(source: { BETTER_AUTH_URL?: string; VERCEL_URL?: string }): string {
  if (source.BETTER_AUTH_URL) return source.BETTER_AUTH_URL;
  if (source.VERCEL_URL) return `https://${source.VERCEL_URL}`;
  throw new Error("Set BETTER_AUTH_URL (or deploy on Vercel, which sets VERCEL_URL)");
}

export function appUrl(): string {
  return resolveAppUrl(env());
}
