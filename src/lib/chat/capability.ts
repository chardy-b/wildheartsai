import { z } from "zod";
import { chatScopeSchema, type ChatScope } from "./contracts";

// Signature verification, key selection, session revocation and origin checks belong to the
// service that received the credential. This pure boundary validates the already-verified
// capability's shape and keeps model-provided ids out of the scope used for data access.
export const runCapabilityClaimsSchema = z.object({
  sub: z.string().min(1),
  cid: z.uuid(),
  rid: z.uuid(),
  attempt: z.number().int().positive(),
  wid: z.string().min(1).max(200),
  jti: z.uuid(),
  aud: z.string().min(1),
  exp: z.number().int().positive(),
  nbf: z.number().int().nonnegative().optional(),
  scope: z.array(z.string()).min(1),
});

export type RunCapabilityClaims = z.infer<typeof runCapabilityClaimsSchema>;

export function scopeFromVerifiedRunCapability(claims: unknown, expectedAudience: string, now = new Date()): ChatScope {
  const parsed = runCapabilityClaimsSchema.parse(claims);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (parsed.aud !== expectedAudience) throw new Error("Chat capability audience is invalid");
  if (!parsed.scope.includes("runner:tool")) throw new Error("Chat capability lacks tool scope");
  if (parsed.exp <= nowSeconds || (parsed.nbf !== undefined && parsed.nbf > nowSeconds)) throw new Error("Chat capability is not active");
  return chatScopeSchema.parse({ userId: parsed.sub, conversationId: parsed.cid, runId: parsed.rid, runAttempt: parsed.attempt, workerId: parsed.wid });
}
