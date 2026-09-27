import { describe, expect, it } from "vitest";
import { enabledEpicEnvironment, parseEnv } from "./env";

const valid = {
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  EMAIL_FROM: "Wild Hearts Health <hello@example.com>",
  EPIC_CLIENT_ID: "client-123",
  EPIC_REDIRECT_URI: "http://localhost:3000/api/epic/callback",
  EPIC_PRIVATE_JWK: '{"kty":"RSA"}',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  RECORDS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

describe("parseEnv", () => {
  it("accepts a complete environment and defaults sign-ups to off", () => {
    const env = parseEnv(valid);
    expect(env.BETTER_AUTH_URL).toBe(valid.BETTER_AUTH_URL);
    expect(env.SIGNUPS_ENABLED).toBe(false);
    expect(env.EPIC_PRODUCTION_ACCESS_ENABLED).toBe(false);
  });

  it("turns SIGNUPS_ENABLED=true into a boolean", () => {
    expect(parseEnv({ ...valid, SIGNUPS_ENABLED: "true" }).SIGNUPS_ENABLED).toBe(true);
  });

  it("rejects a short auth secret", () => {
    expect(() => parseEnv({ ...valid, BETTER_AUTH_SECRET: "short" })).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("defaults to the Epic sandbox and rejects a short encryption key", () => {
    expect(parseEnv(valid).EPIC_ENVIRONMENT).toBe("sandbox");
    expect(() => parseEnv({ ...valid, TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") })).toThrow(
      /TOKEN_ENCRYPTION_KEY/,
    );
  });

  it("requires a separate records key and rejects one reused from the token key", () => {
    expect(parseEnv(valid).RECORDS_ENCRYPTION_KEY).toBe(valid.RECORDS_ENCRYPTION_KEY);
    expect(() => parseEnv({ ...valid, RECORDS_ENCRYPTION_KEY: undefined })).toThrow(/RECORDS_ENCRYPTION_KEY/);
    expect(() => parseEnv({ ...valid, RECORDS_ENCRYPTION_KEY: valid.TOKEN_ENCRYPTION_KEY })).toThrow(/must differ/);
    expect(() => parseEnv({ ...valid, RECORDS_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") })).toThrow(
      /RECORDS_ENCRYPTION_KEY/,
    );
  });

  it("treats blank values, as copied from .env.example, as unset", () => {
    const env = parseEnv({ ...valid, SIGNUP_INVITE_CODE: "", EPIC_RETIRING_PUBLIC_JWK: "" });
    expect(env.SIGNUP_INVITE_CODE).toBeUndefined();
    expect(env.EPIC_RETIRING_PUBLIC_JWK).toBeUndefined();
  });

  it("requires production Epic credentials only when EPIC_ENVIRONMENT is production", () => {
    expect(parseEnv(valid).EPIC_PRODUCTION_CLIENT_ID).toBeUndefined();
    expect(() => parseEnv({ ...valid, EPIC_ENVIRONMENT: "production" })).toThrow(/EPIC_PRODUCTION_CLIENT_ID/);
    expect(() => parseEnv({ ...valid, EPIC_ENVIRONMENT: "production", EPIC_PRODUCTION_CLIENT_ID: "prod-1" })).toThrow(
      /EPIC_PRODUCTION_PRIVATE_JWK/,
    );
    const production = parseEnv({
      ...valid,
      EPIC_ENVIRONMENT: "production",
      EPIC_PRODUCTION_CLIENT_ID: "prod-1",
      EPIC_PRODUCTION_PRIVATE_JWK: '{"kty":"RSA"}',
    });
    expect(production.EPIC_PRODUCTION_CLIENT_ID).toBe("prod-1");
    expect(enabledEpicEnvironment(production)).toBe("sandbox");
    expect(enabledEpicEnvironment({ ...production, EPIC_PRODUCTION_ACCESS_ENABLED: true })).toBe("production");
  });

  it("reads an optional sign-up invite code, treating blank as none", () => {
    expect(parseEnv(valid).SIGNUP_INVITE_CODE).toBeUndefined();
    expect(parseEnv({ ...valid, SIGNUP_INVITE_CODE: "" }).SIGNUP_INVITE_CODE).toBeUndefined();
    expect(parseEnv({ ...valid, SIGNUP_INVITE_CODE: "garden-party" }).SIGNUP_INVITE_CODE).toBe("garden-party");
  });

  it("requires the app's public URL", () => {
    const { BETTER_AUTH_URL: _omit, ...rest } = valid;
    void _omit;
    expect(() => parseEnv(rest)).toThrow(/BETTER_AUTH_URL/);
    expect(() => parseEnv({ ...valid, BETTER_AUTH_URL: "not a url" })).toThrow(/BETTER_AUTH_URL/);
  });
});
