import { describe, expect, it } from "vitest";
import { parseEnv, resolveAppUrl } from "./env";

const valid = {
  DATABASE_URL: "postgresql://user:pass@ep-example.neon.tech/neondb?sslmode=require",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  EMAIL_FROM: "Wild Hearts Health <hello@example.com>",
};

describe("parseEnv", () => {
  it("accepts a complete environment and defaults sign-ups to off", () => {
    const env = parseEnv(valid);
    expect(env.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(env.SIGNUPS_ENABLED).toBe(false);
    expect(env.RESEND_API_KEY).toBeUndefined();
  });

  it("turns SIGNUPS_ENABLED=true into a boolean", () => {
    expect(parseEnv({ ...valid, SIGNUPS_ENABLED: "true" }).SIGNUPS_ENABLED).toBe(true);
  });

  it("rejects a short auth secret", () => {
    expect(() => parseEnv({ ...valid, BETTER_AUTH_SECRET: "short" })).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("rejects a missing database URL", () => {
    const { DATABASE_URL: _omit, ...rest } = valid;
    void _omit;
    expect(() => parseEnv(rest)).toThrow(/DATABASE_URL/);
  });
});

describe("resolveAppUrl", () => {
  it("prefers BETTER_AUTH_URL", () => {
    expect(resolveAppUrl({ BETTER_AUTH_URL: "https://app.example.com", VERCEL_URL: "x.vercel.app" })).toBe(
      "https://app.example.com",
    );
  });

  it("falls back to the Vercel deployment URL", () => {
    expect(resolveAppUrl({ VERCEL_URL: "wildhearts-git-branch.vercel.app" })).toBe(
      "https://wildhearts-git-branch.vercel.app",
    );
  });

  it("throws when neither is set", () => {
    expect(() => resolveAppUrl({})).toThrow(/BETTER_AUTH_URL/);
  });
});
