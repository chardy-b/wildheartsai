import { describe, expect, it } from "vitest";
import { enabledEpicEnvironment, parseSecrets } from "../src/env";

// Made-up values only.
const key = (byte: number) => Buffer.alloc(32, byte).toString("base64");
const valid = {
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "https://wildheartsai.test",
  EMAIL_FROM: "Wild Hearts <no-reply@example.test>",
  EPIC_CLIENT_ID: "client",
  EPIC_REDIRECT_URI: "https://wildheartsai.test/api/epic/callback",
  EPIC_PRIVATE_JWK: "{}",
  TOKEN_ENCRYPTION_KEY: key(1),
  RECORDS_ENCRYPTION_KEY: key(2),
};

describe("parseSecrets", () => {
  it("accepts a complete configuration and applies defaults", () => {
    const parsed = parseSecrets({ ...valid, DB: {}, SIGNUP_INVITE_CODE: "" });
    expect(parsed.SIGNUPS_ENABLED).toBe(false);
    expect(parsed.EPIC_ENVIRONMENT).toBe("sandbox");
    expect(parsed.SIGNUP_INVITE_CODE).toBeUndefined();
  });

  it("fails closed on missing or malformed secrets", () => {
    expect(() => parseSecrets({ ...valid, BETTER_AUTH_URL: undefined })).toThrow();
    expect(() => parseSecrets({ ...valid, TOKEN_ENCRYPTION_KEY: "short" })).toThrow();
    expect(() => parseSecrets({ ...valid, RECORDS_ENCRYPTION_KEY: valid.TOKEN_ENCRYPTION_KEY })).toThrow();
    expect(() => parseSecrets({ ...valid, EPIC_ENVIRONMENT: "production" })).toThrow();
  });

  it("keeps production health systems behind their own switch", () => {
    const production = { ...valid, EPIC_ENVIRONMENT: "production", EPIC_PRODUCTION_CLIENT_ID: "p", EPIC_PRODUCTION_PRIVATE_JWK: "{}" };
    expect(enabledEpicEnvironment(parseSecrets(production))).toBe("sandbox");
    expect(enabledEpicEnvironment(parseSecrets({ ...production, EPIC_PRODUCTION_ACCESS_ENABLED: "true" }))).toBe("production");
  });
});
