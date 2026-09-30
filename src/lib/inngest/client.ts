import { eventType, Inngest, staticSchema } from "inngest";
import type { SyncRequest } from "@/lib/sync/job";

// Job queue. Events carry IDs only; every job loads what it needs from our database,
// so Inngest never sees tokens or health data. Keys come from INNGEST_EVENT_KEY and
// INNGEST_SIGNING_KEY (or INNGEST_DEV=1 with the local dev server).
export const inngest = new Inngest({ id: "wild-hearts-health" });

export const syncRequested = eventType("records/sync.requested", { schema: staticSchema<SyncRequest>() });

// Imports Epic's health system directory now instead of waiting for the daily run: send it from
// the Inngest dashboard after the first deploy, or whenever the directory looks stale.
export const directoryRefreshRequested = eventType("epic/directory.refresh-requested");
