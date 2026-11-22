import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { unseal } from "@/lib/crypto/seal";
import { epicConnection, metriportConnection } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { personaById } from "@/lib/metriport/personas";
import { saveMetriportConnection } from "@/lib/metriport/connections";
import { createTestDb, createTestUser } from "@/test/db";
import { saveConnection, updateTokens } from "./connections";
import { incompleteConnections, resealConnectionTokens } from "./token-roll";

// The token key roll: credentials sealed under the next key too, so they can move to a store that
// only has it. Made-up tokens and ids only.
const current = randomBytes(32), next = randomBytes(32);
const JANE = personaById("jane")!;
const now = new Date("2026-11-22T10:00:00Z");
let db: Db;
let userId: string;

const input = (refreshToken: string | undefined = "rt-1") => ({
  userId,
  fhirBaseUrl: "https://fhir.example.org/api/FHIR/R4",
  organizationName: "Example Health",
  tokenEndpoint: "https://fhir.example.org/oauth2/token",
  tokens: { accessToken: "at-1", refreshToken, expiresAt: new Date("2026-11-22T11:00:00Z"), scope: "patient/Condition.read", patientId: "pat-1" },
});
const openNext = (sealed: string | null) => (sealed === null ? null : unseal(sealed, next));

beforeEach(async () => {
  db = await createTestDb();
  userId = await createTestUser(db);
});

describe("token key roll", () => {
  it("writes nothing extra without a next key", async () => {
    await saveConnection(db, current, input(), now);
    const [row] = await db.select().from(epicConnection);
    expect([row.sealedPatientIdNext, row.sealedAccessTokenNext, row.sealedRefreshTokenNext]).toEqual([null, null, null]);
  });

  it("seals new and refreshed credentials under both keys while the roll is on", async () => {
    await saveConnection(db, { current, next }, input(), now);
    const [row] = await db.select().from(epicConnection);
    expect([unseal(row.sealedAccessToken, current), openNext(row.sealedAccessTokenNext), openNext(row.sealedRefreshTokenNext), openNext(row.sealedPatientIdNext)]).toEqual(["at-1", "at-1", "rt-1", "pat-1"]);
    expect(() => unseal(row.sealedAccessTokenNext!, current)).toThrow();

    await updateTokens(db, { current, next }, row.id, { accessToken: "at-2", refreshToken: "rt-2", expiresAt: now, scope: row.scope }, now);
    const [refreshed] = await db.select().from(epicConnection);
    expect([openNext(refreshed.sealedAccessTokenNext), openNext(refreshed.sealedRefreshTokenNext)]).toEqual(["at-2", "rt-2"]);

    const { sourceId } = await saveMetriportConnection(db, { current, next }, { userId, persona: JANE, patientId: "mp-1", facilityId: "f-1" }, now);
    const [link] = await db.select().from(metriportConnection);
    expect([sourceId.length > 0, openNext(link.sealedPatientIdNext)]).toEqual([true, "mp-1"]);
  });

  it("backfills connections saved before the roll, and can run again", async () => {
    await saveConnection(db, current, input(), now);
    await saveConnection(db, current, { ...input(undefined), fhirBaseUrl: "https://fhir.other.example/api/FHIR/R4" }, now);
    await saveMetriportConnection(db, current, { userId, persona: JANE, patientId: "mp-1", facilityId: "f-1" }, now);
    expect(await incompleteConnections(db)).toBe(3);

    const outcome = await resealConnectionTokens(db, current, next);
    expect(outcome).toEqual({ epic: { resealed: 2, failed: 0 }, metriport: { resealed: 1, failed: 0 }, incomplete: 0 });
    const rows = await db.select().from(epicConnection);
    for (const row of rows) {
      expect(openNext(row.sealedAccessTokenNext)).toBe(unseal(row.sealedAccessToken, current));
      expect(openNext(row.sealedRefreshTokenNext)).toBe(row.sealedRefreshToken ? unseal(row.sealedRefreshToken, current) : null);
    }
    // The old columns are untouched, so Vercel keeps working on them.
    expect(rows.every((row) => unseal(row.sealedPatientId, current) === "pat-1")).toBe(true);
    expect(await resealConnectionTokens(db, current, next)).toMatchObject({ incomplete: 0 });
  });

  it("counts a refresh without the next key as incomplete until the backfill runs again", async () => {
    await saveConnection(db, { current, next }, input(), now);
    const [row] = await db.select().from(epicConnection);
    await updateTokens(db, current, row.id, { accessToken: "at-2", refreshToken: "rt-2", expiresAt: now, scope: row.scope }, now);
    expect(await incompleteConnections(db)).toBe(1);
    expect(await resealConnectionTokens(db, current, next)).toMatchObject({ incomplete: 0 });
    const [fixed] = await db.select().from(epicConnection);
    expect(openNext(fixed.sealedAccessTokenNext)).toBe("at-2");
  });

  it("reports a connection that doesn't open with the current key, and goes on", async () => {
    await saveConnection(db, randomBytes(32), input(), now);
    await saveConnection(db, current, { ...input(), fhirBaseUrl: "https://fhir.other.example/api/FHIR/R4" }, now);
    const outcome = await resealConnectionTokens(db, current, next);
    expect(outcome.epic).toEqual({ resealed: 1, failed: 1 });
    expect(outcome.incomplete).toBe(1);
  });
});
