import { seal } from "./seal";

// The key that seals connection credentials (Epic tokens and patient ids, Metriport patient ids),
// and during a key roll, the next one: the credentials are then also sealed under it, in the
// `_next` columns, so they can move to a store that only has the new key. The owner rolls to a
// new key before the move to Cloudflare, since the current one can't be read back from Vercel.
// See docs/superpowers/plans/2026-11-20-cutover-runbook.md on the cloudflare branch.
export type TokenKeys = Buffer | { current: Buffer; next: Buffer | null };

export function splitTokenKeys(keys: TokenKeys): { current: Buffer; next: Buffer | null } {
  return Buffer.isBuffer(keys) ? { current: keys, next: null } : keys;
}

// Sealed under the current key, and under the next one while a roll is under way (else null).
export function sealUnder(value: string, keys: TokenKeys): { sealed: string; next: string | null } {
  const { current, next } = splitTokenKeys(keys);
  return { sealed: seal(value, current), next: next ? seal(value, next) : null };
}
