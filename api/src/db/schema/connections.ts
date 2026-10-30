import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { now, time } from "../columns";
import { user } from "./auth";
import { healthSource } from "./records";

export const epicConnection = sqliteTable(
  "epic_connection",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    // The organization this connection's tokens belong to. The source, and its records,
    // outlive the connection: disconnecting deletes this row only.
    sourceId: text("source_id").notNull().unique().references(() => healthSource.id, { onDelete: "cascade" }),
    fhirBaseUrl: text("fhir_base_url").notNull(),
    organizationName: text("organization_name").notNull(),
    tokenEndpoint: text("token_endpoint").notNull(),
    // Sealed with TOKEN_ENCRYPTION_KEY. Never store these in plaintext.
    sealedPatientId: text("sealed_patient_id").notNull(),
    sealedAccessToken: text("sealed_access_token").notNull(),
    sealedRefreshToken: text("sealed_refresh_token"),
    accessTokenExpiresAt: time("access_token_expires_at").notNull(),
    scope: text("scope").notNull(),
    createdAt: time("created_at").notNull().default(now),
    updatedAt: time("updated_at").notNull().default(now),
  },
  (table) => [uniqueIndex("epic_connection_user_org_idx").on(table.userId, table.fhirBaseUrl)],
);

// A person's link to Metriport (sandbox sample patients for now). No per-person tokens: the
// API key is the app's own, held server-side in METRIPORT_API_KEY.
export const metriportConnection = sqliteTable(
  "metriport_connection",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull().unique().references(() => healthSource.id, { onDelete: "cascade" }),
    // Which sandbox persona this connection stands for ('jane'); null once real patients exist.
    persona: text("persona"),
    // Sealed with TOKEN_ENCRYPTION_KEY, like epic_connection's patient id.
    sealedPatientId: text("sealed_patient_id").notNull(),
    facilityId: text("facility_id").notNull(),
    createdAt: time("created_at").notNull().default(now),
    updatedAt: time("updated_at").notNull().default(now),
  },
  (table) => [uniqueIndex("metriport_connection_user_persona_idx").on(table.userId, table.persona)],
);
