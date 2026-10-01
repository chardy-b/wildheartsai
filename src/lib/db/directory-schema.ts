import { boolean, index, integer, pgTable, serial, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Epic's public directory of health systems and their clinics (src/lib/epic/brands.ts),
// replaced as a whole by the daily import. Public reference data, not a person's data, so it
// has no user_id and no row-level security.
export const epicDirectoryEntry = pgTable(
  "epic_directory_entry",
  {
    id: serial("id").primaryKey(),
    // "organization" (a health system people connect to) or "facility" (a clinic or hospital in one).
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    fhirBaseUrl: text("fhir_base_url").notNull(),
    partOf: text("part_of"),
    location: text("location"),
    searchText: text("search_text").notNull(),
  },
  (table) => [index("epic_directory_entry_url_idx").on(table.fhirBaseUrl)],
);

// One row per import attempt that got as far as building the directory. The latest row says
// whether the stored directory is loaded, how fresh it is, and lets an unchanged list skip the rewrite.
export const epicDirectoryImport = pgTable("epic_directory_import", {
  id: uuid("id").primaryKey().defaultRandom(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  contentHash: text("content_hash").notNull(),
  changed: boolean("changed").notNull(),
  organizations: integer("organizations").notNull(),
  facilities: integer("facilities").notNull(),
  addresses: integer("addresses").notNull(),
});
