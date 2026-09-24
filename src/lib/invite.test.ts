import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { describe, expect, it } from "vitest";
import { user } from "@/lib/db/schema";
import { createTestDb } from "@/test/db";
import { INVITE_CODE_INVALID, inviteCodeMatches, inviteGate } from "./invite";

describe("inviteCodeMatches", () => {
  it("ignores case and surrounding spaces, and rejects anything else", () => {
    expect(inviteCodeMatches("Garden-Party", " garden-party ")).toBe(true);
    expect(inviteCodeMatches("garden-party", "garden")).toBe(false);
    expect(inviteCodeMatches("garden-party", "")).toBe(false);
    expect(inviteCodeMatches("garden-party", undefined)).toBe(false);
    expect(inviteCodeMatches("garden-party", 42)).toBe(false);
  });
});

async function authWithGate(code: string | undefined) {
  const db = await createTestDb();
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "test-secret-test-secret-test-secret-000",
    database: drizzleAdapter(db, { provider: "pg" }),
    emailAndPassword: { enabled: true },
    hooks: { before: inviteGate(code) },
  });
  const signUp = (body: Record<string, unknown>) =>
    auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ name: "Sam", email: "sam@example.com", password: "long-enough-password", ...body }),
      }),
    );
  return { db, signUp };
}

describe("inviteGate", () => {
  it("refuses sign-up without the right invite code and creates no account", async () => {
    const { db, signUp } = await authWithGate("garden-party");
    for (const body of [{}, { inviteCode: "wrong" }]) {
      const response = await signUp(body);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: INVITE_CODE_INVALID });
    }
    expect(await db.select().from(user)).toHaveLength(0);
  });

  it("lets sign-up through with the invite code", async () => {
    const { db, signUp } = await authWithGate("garden-party");
    const response = await signUp({ inviteCode: "Garden-Party" });
    expect(response.status).toBe(200);
    expect(await db.select({ email: user.email }).from(user)).toEqual([{ email: "sam@example.com" }]);
  });

  it("does nothing when no invite code is configured", async () => {
    const { signUp } = await authWithGate(undefined);
    expect((await signUp({})).status).toBe(200);
  });
});
