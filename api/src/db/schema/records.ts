import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { bool, json, now, time, uuidPk } from "../columns";
import { user } from "./auth";

// Stored health records. Design: docs/superpowers/specs/2026-09-26-record-storage-and-sync-design.md
// Every `sealed_*` column is encrypted with the owner's data key, bound to its table, column,
// user and row. Plaintext columns are limited to what the timeline needs to sort and filter.

const timestamps = {
  createdAt: time("created_at").notNull().default(now),
  updatedAt: time("updated_at").notNull().default(now),
};

// One per user: a random data key, sealed with RECORDS_ENCRYPTION_KEY. Deleting the row
// makes everything sealed under it unreadable, backups included.
export const userDataKey = sqliteTable("user_data_key", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  sealedDek: text("sealed_dek").notNull(),
  kekVersion: integer("kek_version").notNull(),
  createdAt: time("created_at").notNull().default(now),
});

// The organization as the person sees it. Outlives its tokens (epic_connection), so
// disconnecting keeps the records unless the person deletes them.
export const healthSource = sqliteTable(
  "health_source",
  {
    id: uuidPk(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    vendor: text("vendor", { enum: ["epic", "metriport"] }).notNull(),
    fhirBaseUrl: text("fhir_base_url").notNull(),
    organizationName: text("organization_name").notNull(),
    status: text("status", { enum: ["connected", "reconnect_required", "disconnected"] }).notNull(),
    lastSyncedAt: time("last_synced_at"),
    lastSyncStatus: text("last_sync_status", { enum: ["ok", "partial", "failed"] }),
    ...timestamps,
  },
  (table) => [uniqueIndex("health_source_user_url_idx").on(table.userId, table.fhirBaseUrl)],
);

// One row per version of a resource. A newer version supersedes the old row, which is kept.
export const fhirResource = sqliteTable(
  "fhir_resource",
  {
    id: uuidPk(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull().references(() => healthSource.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(),
    fhirId: text("fhir_id").notNull(),
    // Our RecordCategory; null for supporting types such as Practitioner.
    category: text("category"),
    effectiveAt: time("effective_at"),
    datePrecision: text("date_precision", { enum: ["year", "month", "day", "instant"] }),
    sourceVersionId: text("source_version_id"),
    sourceUpdatedAt: time("source_updated_at"),
    contentHmac: text("content_hmac").notNull(),
    sealedResource: text("sealed_resource").notNull(),
    sealedSummary: text("sealed_summary").notNull(),
    normalizerVersion: integer("normalizer_version").notNull(),
    firstSeenAt: time("first_seen_at").notNull(),
    lastSeenAt: time("last_seen_at").notNull(),
    supersededAt: time("superseded_at"),
    supersededBy: text("superseded_by").references((): AnySQLiteColumn => fhirResource.id, { onDelete: "set null" }),
    // Missing from a full pull, or marked entered-in-error at the source.
    removedAt: time("removed_at"),
  },
  (table) => [
    // Exactly one current version per resource per source.
    uniqueIndex("fhir_resource_current_idx")
      .on(table.sourceId, table.resourceType, table.fhirId)
      .where(sql`${table.supersededAt} is null`),
    // SQLite sorts nulls first ascending, so descending puts undated records last, as in Postgres.
    index("fhir_resource_timeline_idx")
      .on(table.userId, sql`${table.effectiveAt} desc`, table.id)
      .where(sql`${table.supersededAt} is null and ${table.removedAt} is null`),
    index("fhir_resource_category_idx")
      .on(table.userId, table.category, sql`${table.effectiveAt} desc`, table.id)
      .where(sql`${table.supersededAt} is null and ${table.removedAt} is null`),
  ],
);

// A note's content, fetched once per URL and kept out of timeline queries.
export const fhirAttachment = sqliteTable(
  "fhir_attachment",
  {
    id: uuidPk(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull().references(() => healthSource.id, { onDelete: "cascade" }),
    resourceId: text("resource_id").notNull().references(() => fhirResource.id, { onDelete: "cascade" }),
    // Sealed: a Binary address can carry identifiers.
    sealedUrl: text("sealed_url").notNull(),
    // HMAC of the address, so "already fetched?" is answerable without decrypting.
    urlHmac: text("url_hmac").notNull(),
    contentType: text("content_type"),
    size: integer("size"),
    sealedText: text("sealed_text"),
    sealedBytes: text("sealed_bytes"),
    fetchedAt: time("fetched_at").notNull(),
  },
  (table) => [uniqueIndex("fhir_attachment_source_url_idx").on(table.sourceId, table.urlHmac)],
);

export type SyncQueryStats = {
  fetched: number;
  inserted: number;
  superseded: number;
  unchanged: number;
  removed: number;
  errorCode?: string;
  // Narrowed to FailureDiagnostic when src/lib/epic/errors.ts is ported (Phase 3).
  failureStage?: string;
  failureCode?: string;
  httpStatus?: number;
  // A search not every organization supports: a failure isn't reported to the person.
  optional?: boolean;
};

// One sync of one source. Stats hold counts and error codes only, never PHI.
export const syncRun = sqliteTable(
  "sync_run",
  {
    id: uuidPk(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull().references(() => healthSource.id, { onDelete: "cascade" }),
    trigger: text("trigger", { enum: ["connect", "manual", "scheduled"] }).notNull(),
    status: text("status", { enum: ["queued", "running", "ok", "partial", "failed"] }).notNull(),
    stats: json<Record<string, SyncQueryStats>>("stats").notNull().default({}),
    queuedAt: time("queued_at").notNull().default(now),
    startedAt: time("started_at"),
    finishedAt: time("finished_at"),
  },
  (table) => [
    // At most one active run per source.
    uniqueIndex("sync_run_active_idx").on(table.sourceId).where(sql`${table.status} in ('queued', 'running')`),
    index("sync_run_source_idx").on(table.sourceId, sql`${table.queuedAt} desc`),
  ],
);

// Per source and query ('Observation:laboratory'): where incremental sync resumes from.
// No user_id: a cursor belongs to whoever owns its source (see src/data/scope.ts).
export const syncCursor = sqliteTable(
  "sync_cursor",
  {
    sourceId: text("source_id").notNull().references(() => healthSource.id, { onDelete: "cascade" }),
    queryKey: text("query_key").notNull(),
    lastSuccessAt: time("last_success_at"),
    // Last full re-pull; only full pulls can detect removed records.
    lastFullAt: time("last_full_at"),
    // Whether the server honoured _lastUpdated for this query when probed; null = not probed yet.
    supportsLastUpdated: bool("supports_last_updated"),
  },
  (table) => [primaryKey({ columns: [table.sourceId, table.queryKey] })],
);
