// Shared with src/lib/sync/run.ts in the Next app; kept here so the API doesn't load that module
// (it imports the Postgres schema). Phase 4 ports the sync job and makes this the only copy.

// A queued or running run older than this was lost (its job never ran or died without
// reporting), so it no longer blocks new runs.
export const STALE_RUN_MS = 3 * 60 * 60 * 1000;

// Manual refreshes of one source are at most this frequent.
export const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
