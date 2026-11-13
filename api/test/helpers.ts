import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair } from "jose";
import { createAuth } from "../src/auth";
import { forUser } from "../src/data/scope";
import { database } from "../src/db";
import * as s from "../src/db/schema";
import type { Bindings } from "../src/env";

// Made-up keys and people for tests only.
export const db = database(env.DB);
export const tokenKey = Buffer.from(env.TOKEN_ENCRYPTION_KEY!, "base64");
export const recordsKey = Buffer.from(env.RECORDS_ENCRYPTION_KEY!, "base64");
export const origin = "http://localhost:3000";

export async function person(id: string) {
  await db.insert(s.user).values({ id, name: id, email: `${id}@example.test`, emailVerified: true, updatedAt: new Date() }).onConflictDoNothing();
  return forUser(db, id);
}

export async function clearAll() {
  await db.delete(s.user);
  await db.delete(s.auditEvent);
  await db.delete(s.epicDirectoryEntry);
  await db.delete(s.epicDirectoryImport);
}

export async function privateJwk(): Promise<string> {
  const { privateKey } = await generateKeyPair("RS384", { modulusLength: 2048, extractable: true });
  return JSON.stringify({ ...(await exportJWK(privateKey)), kid: "test-key-1" });
}

// A verified account signed in through Better Auth, and its session cookie.
export async function signedIn(email: string, overrides: Partial<Bindings> = {}): Promise<{ userId: string; cookie: string }> {
  const auth = createAuth({ ...env, ...overrides } as Bindings, { sendEmail: async () => {} });
  const password = "made-up-test-password";
  const { user } = await auth.api.signUpEmail({ body: { email, password, name: email } });
  await db.update(s.user).set({ emailVerified: true });
  const response = await auth.handler(new Request(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "cf-connecting-ip": "198.51.100.20" },
    body: JSON.stringify({ email, password }),
  }));
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token="))!.split(";")[0];
  return { userId: user.id, cookie };
}

export const tokens = (accessToken: string, refreshToken: string | undefined, expiresInMs: number) => ({
  accessToken,
  refreshToken,
  expiresAt: new Date(Date.now() + expiresInMs),
  scope: "openid fhirUser patient/Observation.read",
  patientId: "made-up-patient",
});
