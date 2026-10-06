import { SignJWT, jwtVerify } from "jose";
import type { CapabilityVerifier, ChatScope, PublicCapability } from "./contracts.js";

type Claims = { sub?: string; sid?: string; cid?: string; rid?: string; jti?: string; attempt?: unknown; wid?: string; scope?: unknown };

export class JwtCapabilityVerifier implements CapabilityVerifier {
  constructor(
    private readonly key: Uint8Array,
    private readonly issuer: string,
    private readonly isSessionActive: (sessionId: string, userId: string) => Promise<boolean>,
  ) {}

  async verify(token: string): Promise<PublicCapability | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: this.issuer, audience: "wildhearts-chat", algorithms: ["HS256"] });
      const claims = payload as Claims;
      if (typeof claims.sub !== "string" || typeof claims.sid !== "string" || typeof claims.jti !== "string" ||
        typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.exp - payload.iat > 90 ||
        !(await this.isSessionActive(claims.sid, claims.sub))) return null;
      return {
        userId: claims.sub,
        sessionId: claims.sid,
        credentialId: claims.jti,
        expiresAt: new Date((payload.exp ?? 0) * 1_000),
        audience: "wildhearts-chat",
      };
    } catch {
      return null;
    }
  }
}

export type RunnerCapability = ChatScope & Readonly<{ scope: "runner:tool"; runAttempt: number; workerId: string }>;

/** The HMAC key is held by the trusted service only; runners receive only the short-lived token. */
export async function mintRunnerCapability(scope: ChatScope, key: Uint8Array, issuer: string, attempt: number, workerId: string, ttlSeconds = 300): Promise<string> {
  if (!scope.runId || !Number.isSafeInteger(attempt) || attempt < 1 || !workerId) throw new Error("A runner capability requires a fenced run lease");
  return new SignJWT({ cid: scope.conversationId, rid: scope.runId, attempt, wid: workerId, scope: ["runner:tool"] })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(scope.userId)
    .setIssuer(issuer)
    .setAudience("wild-hearts-chat-runner")
    .setJti(scope.credentialId)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
}

export async function verifyRunnerCapability(token: string, key: Uint8Array, issuer: string): Promise<RunnerCapability | null> {
  try {
    const { payload } = await jwtVerify(token, key, { issuer, audience: "wild-hearts-chat-runner" });
    const claims = payload as Claims;
    if (typeof claims.sub !== "string" || typeof claims.cid !== "string" || typeof claims.rid !== "string" || typeof claims.jti !== "string" || typeof claims.wid !== "string" ||
      typeof claims.attempt !== "number" || !Number.isSafeInteger(claims.attempt) || claims.attempt < 1 ||
      !Array.isArray(claims.scope) || !claims.scope.includes("runner:tool")) return null;
    return { userId: claims.sub, conversationId: claims.cid, runId: claims.rid, credentialId: claims.jti, expiresAt: new Date((payload.exp ?? 0) * 1_000), runAttempt: claims.attempt, workerId: claims.wid, scope: "runner:tool" };
  } catch {
    return null;
  }
}
