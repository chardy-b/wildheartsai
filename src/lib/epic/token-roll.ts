import "server-only";
import { eq, isNull, or, and, isNotNull, count } from "drizzle-orm";
import { seal, unseal } from "@/lib/crypto/seal";
import { epicConnection, metriportConnection } from "@/lib/db/schema";
import { asUser } from "@/lib/db/rls";
import type { Db } from "@/lib/db/types";

// The backfill of a token key roll (src/lib/crypto/token-keys.ts): every Epic and Metriport
// connection's credentials sealed again under the next key, into the `_next` columns. New and
// refreshed credentials are already written both ways while TOKEN_ENCRYPTION_KEY_NEXT is set;
// this covers the rest. Each connection is re-sealed in its owner's context, under a row lock,
// so a refresh in progress can't be overwritten with older values. Safe to run again. Counts only:
// no credential or identifier leaves this function.

export type ResealOutcome = { epic: { resealed: number; failed: number }; metriport: { resealed: number; failed: number }; incomplete: number };

export async function resealConnectionTokens(db: Db, current: Buffer, next: Buffer): Promise<ResealOutcome> {
  const outcome: ResealOutcome = { epic: { resealed: 0, failed: 0 }, metriport: { resealed: 0, failed: 0 }, incomplete: 0 };
  const again = (value: string) => seal(unseal(value, current), next);

  // Background context: every row is visible (src/lib/db/rls.ts); ids and owners only.
  for (const { id, userId } of await db.select({ id: epicConnection.id, userId: epicConnection.userId }).from(epicConnection)) {
    try {
      await asUser(db, userId, async (tx) => {
        const [row] = await tx.select().from(epicConnection).where(eq(epicConnection.id, id)).limit(1).for("update");
        if (!row) return;
        await tx.update(epicConnection).set({
          sealedPatientIdNext: again(row.sealedPatientId),
          sealedAccessTokenNext: again(row.sealedAccessToken),
          sealedRefreshTokenNext: row.sealedRefreshToken ? again(row.sealedRefreshToken) : null,
        }).where(eq(epicConnection.id, id));
      });
      outcome.epic.resealed++;
    } catch {
      outcome.epic.failed++;
    }
  }
  for (const { id, userId } of await db.select({ id: metriportConnection.id, userId: metriportConnection.userId }).from(metriportConnection)) {
    try {
      await asUser(db, userId, async (tx) => {
        const [row] = await tx.select().from(metriportConnection).where(eq(metriportConnection.id, id)).limit(1).for("update");
        if (!row) return;
        await tx.update(metriportConnection).set({ sealedPatientIdNext: again(row.sealedPatientId) }).where(eq(metriportConnection.id, id));
      });
      outcome.metriport.resealed++;
    } catch {
      outcome.metriport.failed++;
    }
  }
  outcome.incomplete = await incompleteConnections(db);
  return outcome;
}

// Connections whose credentials aren't (all) sealed under the next key yet. Zero before the copy.
export async function incompleteConnections(db: Db): Promise<number> {
  const [epic] = await db.select({ n: count() }).from(epicConnection).where(or(
    isNull(epicConnection.sealedPatientIdNext),
    isNull(epicConnection.sealedAccessTokenNext),
    and(isNotNull(epicConnection.sealedRefreshToken), isNull(epicConnection.sealedRefreshTokenNext)),
  ));
  const [metriport] = await db.select({ n: count() }).from(metriportConnection).where(isNull(metriportConnection.sealedPatientIdNext));
  return epic.n + metriport.n;
}
