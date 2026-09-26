import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { epicConnection, healthSource } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { createTestDb, createTestUser } from "@/test/db";
import { deleteConnection, getConnectionForSource, getConnectionSecrets, listConnections, saveConnection, updateTokens } from "./connections";

const key = randomBytes(32);
const now = new Date("2026-09-23T10:00:00Z");
let db: Db;
let userId: string;

const input = () => ({
  userId,
  fhirBaseUrl: "https://fhir.example.org/api/FHIR/R4",
  organizationName: "Example Health",
  tokenEndpoint: "https://fhir.example.org/oauth2/token",
  tokens: {
    accessToken: "at-1",
    refreshToken: "rt-1",
    expiresAt: new Date("2026-09-23T11:00:00Z"),
    scope: "patient/Condition.read",
    patientId: "pat-1",
  },
});

beforeEach(async () => {
  db = await createTestDb();
  userId = await createTestUser(db);
});

describe("epic connections", () => {
  it("stores tokens and the patient ID sealed, never in plaintext", async () => {
    await saveConnection(db, key, input(), now);
    const [row] = await db.select().from(epicConnection);
    expect(JSON.stringify(row)).not.toMatch(/at-1|rt-1|pat-1/);
  });

  it("lists connections without secrets", async () => {
    await saveConnection(db, key, input(), now);
    const list = await listConnections(db, userId);
    expect(list).toEqual([
      {
        id: expect.any(String),
        organizationName: "Example Health",
        fhirBaseUrl: "https://fhir.example.org/api/FHIR/R4",
        scope: "patient/Condition.read",
        connectedAt: now,
      },
    ]);
    expect(JSON.stringify(list)).not.toMatch(/at-1|rt-1|pat-1/);
  });

  it("decrypts secrets for server use", async () => {
    await saveConnection(db, key, input(), now);
    const [secrets] = await getConnectionSecrets(db, key, userId);
    expect(secrets).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1", patientId: "pat-1" });
  });

  it("reconnecting the same organization updates the existing row", async () => {
    await saveConnection(db, key, input(), now);
    await saveConnection(db, key, { ...input(), tokens: { ...input().tokens, accessToken: "at-9" } }, now);
    const secrets = await getConnectionSecrets(db, key, userId);
    expect(secrets).toHaveLength(1);
    expect(secrets[0].accessToken).toBe("at-9");
  });

  it("keeps the refresh token when a refresh does not rotate it", async () => {
    await saveConnection(db, key, input(), now);
    const [{ id }] = await listConnections(db, userId);
    await updateTokens(db, key, id, { accessToken: "at-2", expiresAt: new Date("2026-09-23T12:00:00Z"), scope: "patient/Condition.read" }, now);
    const [secrets] = await getConnectionSecrets(db, key, userId);
    expect(secrets).toMatchObject({ accessToken: "at-2", refreshToken: "rt-1" });
  });

  it("only deletes a connection that belongs to the user", async () => {
    await saveConnection(db, key, input(), now);
    const [{ id }] = await listConnections(db, userId);
    const otherUser = await createTestUser(db, "user_test_2");
    expect(await deleteConnection(db, otherUser, id)).toBe(false);
    expect(await deleteConnection(db, userId, id)).toBe(true);
    expect(await listConnections(db, userId)).toEqual([]);
  });

  it("creates one source per organization and reuses it on reconnect", async () => {
    await saveConnection(db, key, input(), now);
    await saveConnection(db, key, { ...input(), organizationName: "Example Health (renamed)" }, now);
    const sources = await db.select().from(healthSource);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ userId, vendor: "epic", status: "connected", organizationName: "Example Health (renamed)" });
    const [row] = await db.select().from(epicConnection);
    expect(row.sourceId).toBe(sources[0].id);
  });

  it("keeps the source, marked disconnected, when disconnecting", async () => {
    await saveConnection(db, key, input(), now);
    const [{ id }] = await listConnections(db, userId);
    await deleteConnection(db, userId, id, now);
    expect(await db.select().from(epicConnection)).toEqual([]);
    const [source] = await db.select().from(healthSource);
    expect(source.status).toBe("disconnected");
  });

  it("reattaches to the same source when reconnecting after a disconnect", async () => {
    await saveConnection(db, key, input(), now);
    const [before] = await db.select().from(healthSource);
    const [{ id }] = await listConnections(db, userId);
    await deleteConnection(db, userId, id, now);
    await saveConnection(db, key, input(), now);
    const sources = await db.select().from(healthSource);
    expect(sources).toEqual([expect.objectContaining({ id: before.id, status: "connected" })]);
  });

  it("does not touch the source when another user tries to disconnect", async () => {
    await saveConnection(db, key, input(), now);
    const [{ id }] = await listConnections(db, userId);
    const otherUser = await createTestUser(db, "user_test_2");
    await deleteConnection(db, otherUser, id, now);
    const [source] = await db.select().from(healthSource);
    expect(source.status).toBe("connected");
  });

  it("finds a source's connection only for its owner, and none after disconnecting", async () => {
    const { sourceId } = await saveConnection(db, key, input(), now);
    expect(await getConnectionForSource(db, key, userId, sourceId)).toMatchObject({ patientId: "pat-1" });
    const otherUser = await createTestUser(db, "user_test_3");
    expect(await getConnectionForSource(db, key, otherUser, sourceId)).toBeUndefined();
    const [{ id }] = await listConnections(db, userId);
    await deleteConnection(db, userId, id, now);
    expect(await getConnectionForSource(db, key, userId, sourceId)).toBeUndefined();
  });
});
