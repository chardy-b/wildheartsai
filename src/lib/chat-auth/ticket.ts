import "server-only";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

export function chatConfiguration(source: Record<string, string | undefined> = process.env): { apiUrl: string; signingKey: string } | null {
  const apiUrl = source.CHAT_API_URL;
  const signingKey = source.CHAT_SIGNING_KEY;
  if (!apiUrl || !signingKey || Buffer.byteLength(signingKey) < 32) return null;
  try {
    const url = new URL(apiUrl);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    return { apiUrl: url.origin, signingKey };
  } catch { return null; }
}

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
