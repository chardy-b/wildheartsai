import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import type { Db } from "@/lib/db/types";
import { completeOnboarding, getProfile, recordAcknowledgement, savePreferredName } from "./profile";

let db: Db;
let userId: string;

beforeEach(async () => {
  db = await createTestDb();
  userId = await createTestUser(db);
});

describe("profile repository", () => {
  it("returns undefined before anything is saved", async () => {
    expect(await getProfile(db, userId)).toBeUndefined();
  });

  it("creates the profile on first save and updates it after", async () => {
    await savePreferredName(db, userId, "Sam", new Date("2026-09-23T10:00:00Z"));
    await savePreferredName(db, userId, "Samantha", new Date("2026-09-23T10:05:00Z"));
    const saved = await getProfile(db, userId);
    expect(saved?.preferredName).toBe("Samantha");
    expect(saved?.updatedAt.toISOString()).toBe("2026-09-23T10:05:00.000Z");
  });

  it("records the acknowledgement version and completion time", async () => {
    await savePreferredName(db, userId, "Sam", new Date());
    await recordAcknowledgement(db, userId, "v-test", new Date("2026-09-23T11:00:00Z"));
    await completeOnboarding(db, userId, new Date("2026-09-23T11:01:00Z"));
    const saved = await getProfile(db, userId);
    expect(saved?.consentVersion).toBe("v-test");
    expect(saved?.consentedAt?.toISOString()).toBe("2026-09-23T11:00:00.000Z");
    expect(saved?.onboardedAt?.toISOString()).toBe("2026-09-23T11:01:00.000Z");
  });
});
