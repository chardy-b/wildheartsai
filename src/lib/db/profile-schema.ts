import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";
import { createdAt, timestamp, updatedAt } from "./columns";

export const profile = sqliteTable("profile", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  preferredName: text("preferred_name"),
  consentVersion: text("consent_version"),
  consentedAt: timestamp("consented_at"),
  onboardedAt: timestamp("onboarded_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
