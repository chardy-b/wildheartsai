import "server-only";
import { isDemoIdentity } from "./identity";

// Only server-created fictional identities, never an email comparison.
export function isDemoUser(userId: string): boolean {
  return process.env.DEMO_ENABLED === "1" && isDemoIdentity(userId);
}

