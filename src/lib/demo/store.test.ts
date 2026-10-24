import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, createTestUser } from "@/test/db";
import { fhirResource, healthSource, user, account, epicConnection } from "@/lib/db/schema";
import { asUser } from "@/lib/db/rls";
import { userKeysFor } from "@/lib/crypto/user-keys";
import { storedNoteText } from "@/lib/sync/notes";
import { sourcesDueForRefresh } from "@/lib/sync/scheduled";
import { DEMO_USER_ID, buildDemoScenario } from "./scenario";
import { demoSnapshot, importDemoDocument, populateDemo } from "./store";
import { provisionDemo } from "./provision";
import { calculateLabTrend, findRecords, readRecords } from "@/lib/chat/gateway";

const kek = Buffer.alloc(32, 12), now = new Date("2026-10-21T12:00:00Z");

describe("fictional patient demo in the real encrypted record store", () => {
  it("is queryable by the actual chat tools with owned citations and deterministic trends", async () => {
    const db = await createTestDb();
    const key = Buffer.from(process.env.RECORDS_ENCRYPTION_KEY!, "base64");
    await provisionDemo(db, key, { email: "demo@example.test", passwordHash: "synthetic-hash", now });
    const scope = { userId: DEMO_USER_ID };
    const results = await findRecords(db, scope, { query: "Esophageal biopsy peak eosinophils", limit: 20 });
    expect(results.records).toHaveLength(2);
    const ids = results.records.map(record => record.citation.id);
    const detail = await readRecords(db, scope, { recordIds: ids, includeDetails: true });
    expect(detail).toHaveLength(2);
    const trend = await calculateLabTrend(db, scope, { recordIds: ids });
    expect(trend).toMatchObject({ ok: true, change: -34 });
    const other = await createTestUser(db, "demo_tools_other");
    expect(await readRecords(db, { userId: other }, { recordIds: ids, includeDetails: true })).toEqual([]);
  });
  it("imports all normalizable record types and stored notes, and does not create live connections or duplicate records", async () => {
    const db = await createTestDb();
    await provisionDemo(db, kek, { email: "demo@example.test", passwordHash: "synthetic-hash", now });
    const first = (await demoSnapshot(db, kek, DEMO_USER_ID))!;
    expect(first.anchor).toBe("2026-10-21");
    expect(first.records).toHaveLength(buildDemoScenario(first.anchor).length);
    expect(first.sources).toHaveLength(3);
    expect(first.records.find(r => r.fhirId === "eos-repeat")?.detail).toContain("8");
    expect(first.records.filter(r => r.category === "appointment")).toHaveLength(3);
    expect(first.records.find(r => r.fhirId === "flushing")?.title).toContain("NOT diagnosed");
    await populateDemo(db, kek, DEMO_USER_ID, { now: new Date("2026-11-01T12:00:00Z") });
    const second = (await demoSnapshot(db, kek, DEMO_USER_ID))!;
    expect(second.anchor).toBe(first.anchor);
    expect(second.records.map(r => r.id).sort()).toEqual(first.records.map(r => r.id).sort());
    const stored = await db.select().from(fhirResource);
    expect(stored.every(r => !r.sealedResource.includes("Alex") && !r.sealedSummary.includes("esophagitis"))).toBe(true);
    expect(await db.select().from(epicConnection)).toHaveLength(0);
    expect(await sourcesDueForRefresh(db, new Date("2027-01-01"))).toHaveLength(0);
    await asUser(db, DEMO_USER_ID, async tx => {
      const keys = await userKeysFor(tx, kek, DEMO_USER_ID, now);
      const note = first.records.find(r => r.fhirId === "allergy-assessment")!;
      expect(await storedNoteText(tx, keys, DEMO_USER_ID, note.sourceId, "Binary/allergy-assessment")).toContain("no MCAS diagnosis");
    });
  });

  it("adds the PDF's referenced records idempotently and resets only fictional sources", async () => {
    const db = await createTestDb();
    const other = await createTestUser(db, "ordinary_patient");
    await db.insert(healthSource).values({ userId: other, vendor: "epic", fhirBaseUrl: "https://actual.example/FHIR/R4", organizationName: "Other person's source", status: "disconnected" });
    await provisionDemo(db, kek, { email: "demo@example.test", passwordHash: "synthetic-hash", now });
    await importDemoDocument(db, kek, DEMO_USER_ID);
    await importDemoDocument(db, kek, DEMO_USER_ID);
    const snapshot = (await demoSnapshot(db, kek, DEMO_USER_ID))!;
    expect(snapshot.records.filter(r => r.fhirId === "outside-ferritin")).toHaveLength(1);
    expect(JSON.stringify(snapshot.records.find(r => r.fhirId === "outside-ferritin")?.resource)).toContain("DocumentReference/outside-report");
    expect(snapshot.sources).toHaveLength(4);
    expect(JSON.stringify(snapshot)).not.toContain("Other person's");
    expect(() => populateDemo(db, kek, other, { reset: true })).toThrow("demo_forbidden");
    expect(() => demoSnapshot(db, kek, other)).toThrow("demo_forbidden");
    await populateDemo(db, kek, DEMO_USER_ID, { reset: true, now });
    expect((await demoSnapshot(db, kek, DEMO_USER_ID))!.records.some(r => r.fhirId === "outside-report")).toBe(false);
    expect(await db.select().from(healthSource).where(eq(healthSource.userId, other))).toHaveLength(1);
  });

  it("never adopts another person's email or rotates an existing demo credential on re-seed", async () => {
    const db = await createTestDb();
    const other = await createTestUser(db, "email_owner");
    const [owner] = await db.select().from(user).where(eq(user.id, other));
    await expect(provisionDemo(db, kek, { email: owner.email, passwordHash: "new-hash", now })).rejects.toThrow("another account");
    expect(await db.select().from(user).where(eq(user.id, DEMO_USER_ID))).toHaveLength(0);
    await provisionDemo(db, kek, { email: "demo@example.test", passwordHash: "original-hash", now });
    await provisionDemo(db, kek, { email: "demo@example.test", passwordHash: "new-hash", now });
    const [credential] = await db.select().from(account).where(eq(account.userId, DEMO_USER_ID));
    expect(credential.password).toBe("original-hash");
  });
});
