import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { JwtCapabilityVerifier, mintRunnerCapability, verifyRunnerCapability } from "../src/capabilities.js";
import { mintChatTicket } from "../../../src/lib/chat-auth/ticket.js";

const key = new TextEncoder().encode("a test key that is long enough for HS256 signing");

describe("capabilities", () => {
  it("requires a bound active session and rejects overly long browser tickets", async () => {
    const token = await mintChatTicket({ sessionId: "session-a", userId: "person-a" }, new TextDecoder().decode(key));
    const verifier = new JwtCapabilityVerifier(key, "wildhearts-web", async (sid, userId) => sid === "session-a" && userId === "person-a");
    await expect(verifier.verify(token)).resolves.toMatchObject({ userId: "person-a", sessionId: "session-a" });
    const longToken = await new SignJWT({ sid: "session-a" }).setProtectedHeader({ alg: "HS256" }).setSubject("person-a").setIssuer("wildhearts-web").setAudience("wildhearts-chat").setJti("ticket-b").setIssuedAt().setExpirationTime("5m").sign(key);
    await expect(verifier.verify(longToken)).resolves.toBeNull();
  });

  it("fences runner capabilities to one attempt and worker owner", async () => {
    const token = await mintRunnerCapability({ userId: "person-a", conversationId: "conversation-a", runId: "run-a", credentialId: "ticket-a", expiresAt: new Date() }, key, "chat-service", 3, "worker-a");
    await expect(verifyRunnerCapability(token, key, "chat-service")).resolves.toMatchObject({ runAttempt: 3, workerId: "worker-a", runId: "run-a" });
  });
});
