import { z } from "zod";

const schema = z
  .object({
    BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
    // The public origin of this deployment: its custom domain, workers.dev URL or http://localhost:3000.
    BETTER_AUTH_URL: z.url(),
    // Sender for verification and reset emails, on a domain onboarded to Cloudflare Email Service (src/lib/email.ts).
    EMAIL_FROM: z.string().min(3),
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
    // Key-encryption key for stored health records (src/lib/crypto/user-keys.ts). Must differ from TOKEN_ENCRYPTION_KEY.
    RECORDS_ENCRYPTION_KEY: z
      .string()
      .refine((value) => Buffer.from(value, "base64").length === 32, "RECORDS_ENCRYPTION_KEY must be 32 bytes, base64-encoded"),
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

// The public origin of this deployment.
export function appUrl(): string {
  return env().BETTER_AUTH_URL;
}
