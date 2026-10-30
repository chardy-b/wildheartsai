import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { bool, now, time, uuidPk } from "../columns";

// Epic's public directory of health systems and their clinics. Public reference data, not a
// person's data, so it has no user_id.
export const epicDirectoryEntry = sqliteTable(
  "epic_directory_entry",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
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

// One row per import attempt that got as far as building the directory.
export const epicDirectoryImport = sqliteTable("epic_directory_import", {
  id: uuidPk(),
  importedAt: time("imported_at").notNull().default(now),
  contentHash: text("content_hash").notNull(),
  changed: bool("changed").notNull(),
  organizations: integer("organizations").notNull(),
  facilities: integer("facilities").notNull(),
  addresses: integer("addresses").notNull(),
});
