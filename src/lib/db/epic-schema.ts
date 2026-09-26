import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";
import { createdAt, timestamp, updatedAt, uuid } from "./columns";
import { healthSource } from "./records-schema";

export const epicConnection = sqliteTable(
  "epic_connection",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // The organization this connection's tokens belong to. The source, and its records,
    // outlive the connection: disconnecting deletes this row only.
    sourceId: uuid("source_id")
      .notNull()
      .unique()
      .references(() => healthSource.id, { onDelete: "cascade" }),
    fhirBaseUrl: text("fhir_base_url").notNull(),
    organizationName: text("organization_name").notNull(),
    tokenEndpoint: text("token_endpoint").notNull(),
    // Sealed with TOKEN_ENCRYPTION_KEY (src/lib/crypto/seal.ts). Never store these in plaintext.
    sealedPatientId: text("sealed_patient_id").notNull(),
    sealedAccessToken: text("sealed_access_token").notNull(),
    sealedRefreshToken: text("sealed_refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at").notNull(),
    scope: text("scope").notNull(),
    // Lease held while one request refreshes the tokens (src/lib/epic/server.ts). D1 has no
    // row locks, so this serializes rotating refresh tokens across requests and isolates.
    refreshLeaseUntil: timestamp("refresh_lease_until"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("epic_connection_user_org_idx").on(table.userId, table.fhirBaseUrl)],
);
