import { getCloudflareContext } from "@opennextjs/cloudflare";
import { drizzle } from "drizzle-orm/d1";
import { lazy } from "@/lib/lazy";
import * as schema from "./schema";
import type { Db } from "./types";

// Cloudflare D1, through the `DB` binding (wrangler.jsonc). The binding is the same object
// for every request in an isolate, so one Drizzle instance serves them all.
// Created on first query, so builds don't need the binding.
export const db = lazy((): Db => drizzle(getCloudflareContext().env.DB, { schema }));

export type { Db };
