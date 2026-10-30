import { keysFrom, KEK_VERSION, newSealedDek, type UserKeys } from "../crypto/fields";
import { userDataKey } from "../db/schema";
import type { UserScope } from "./scope";

// The user's keys, creating their data key on first use. Safe to call concurrently: the first
// insert wins and every caller reads the stored row (two single statements, no transaction).
export async function userKeysFor(scope: UserScope, kek: Buffer, now: Date): Promise<UserKeys> {
  await scope
    .insert(userDataKey, { userId: scope.userId, sealedDek: newSealedDek(kek, scope.userId), kekVersion: KEK_VERSION, createdAt: now })
    .onConflictDoNothing();
  const [row] = await scope.select(userDataKey).limit(1);
  if (!row) throw new Error("User data key missing after insert");
  return keysFrom(scope.userId, row.sealedDek, kek, row.kekVersion);
}

// Permanently makes the user's stored records unreadable.
export async function shredUserKeys(scope: UserScope): Promise<void> {
  await scope.delete(userDataKey);
}
