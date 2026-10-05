import "server-only";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

export { chatConfiguration } from "./configuration";

export async function mintChatTicket(identity: { userId: string; sessionId: string }, signingKey: string) {
  return new SignJWT({ sid: identity.sessionId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(identity.userId)
    .setIssuer("wildhearts-web")
    .setAudience("wildhearts-chat")
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("90s")
    .sign(new TextEncoder().encode(signingKey));
}
