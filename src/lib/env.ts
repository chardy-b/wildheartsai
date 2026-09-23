import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.url().optional(),
  VERCEL_URL: z.string().optional(),
  EMAIL_FROM: z.string().min(3),
  RESEND_API_KEY: z.string().min(1).optional(),
  SIGNUPS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type ServerEnv = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined>): ServerEnv {
  return schema.parse(source);
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
