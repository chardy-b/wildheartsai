import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { healthSource } from "./records-schema";

export const epicConnection = pgTable(
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
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }).notNull(),
    scope: text("scope").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("epic_connection_user_org_idx").on(table.userId, table.fhirBaseUrl)],
);
