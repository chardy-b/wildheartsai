import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { healthSource } from "./records-schema";

// A person's link to Metriport (sandbox sample patients for now). Unlike epic_connection there
// are no per-person tokens: the API key is the app's own, held server-side in METRIPORT_API_KEY.
export const metriportConnection = pgTable(
  "metriport_connection",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .unique()
      .references(() => healthSource.id, { onDelete: "cascade" }),
    // Which sandbox persona this connection stands for ('jane'); null once real patients exist.
    persona: text("persona"),
    // Sealed with TOKEN_ENCRYPTION_KEY, like epic_connection's patient id.
    sealedPatientId: text("sealed_patient_id").notNull(),
    facilityId: text("facility_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("metriport_connection_user_persona_idx").on(table.userId, table.persona)],
);
