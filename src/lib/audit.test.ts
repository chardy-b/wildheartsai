import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditEvent, syncRun } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { deleteConnection, getConnectionSecrets, saveConnection } from "@/lib/epic/connections";
import { createTestDb, createTestUser } from "@/test/db";
import { deleteSource } from "./sources";
import { failRun, finishRun, recordStats, startRun } from "./sync/run";

const tokenKey = randomBytes(32);
const now = new Date("2026-09-27T12:00:00Z");
let db: Db;
let userId: string;
let nextUser = 0;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  userId = await createTestUser(db, `audit_user_${++nextUser}`);
});

const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

const connect = (when = now, organizationName = "Lakeside Cardiology") =>
  saveConnection(
    db,
    tokenKey,
    {
      userId,
      fhirBaseUrl: "https://lakeside.example/R4",
      organizationName,
      tokenEndpoint: "https://lakeside.example/token",
      tokens: { accessToken: "secret-at", refreshToken: "secret-rt", expiresAt: when, scope: "s", patientId: "patient-123" },
    },
    when,
  );

const events = () =>
  db.select({ action: auditEvent.action, sourceId: auditEvent.sourceId, detail: auditEvent.detail }).from(auditEvent).where(eq(auditEvent.userId, userId)).orderBy(asc(auditEvent.createdAt));

describe("audit trail", () => {
  it("records connecting, reconnecting, disconnecting and deleting, and outlives the source", async () => {
    const { sourceId } = await connect();
    const [connection] = await getConnectionSecrets(db, tokenKey, userId);
    await deleteConnection(db, userId, connection.id, at(1));
    await connect(at(2));
    expect(await deleteSource(db, userId, sourceId, at(3))).toBe(true);

    expect((await events()).map((e) => [e.action, e.sourceId])).toEqual([
      ["connect", sourceId],
      ["disconnect", sourceId],
      ["reconnect", sourceId],
      ["delete_source", sourceId],
    ]);
  });

  it("records nothing for an action that didn't happen", async () => {
    const { sourceId } = await connect();
    const other = await createTestUser(db, `audit_other_${nextUser}`);
    expect(await deleteSource(db, other, sourceId, now)).toBe(false);
    expect(await deleteConnection(db, other, "not-a-connection", now)).toBe(false);
    expect((await events()).map((e) => e.action)).toEqual(["connect"]);
  });

  it("records each sync's outcome with counts only", async () => {
    const { sourceId } = await connect();
    const first = await startRun(db, { userId, sourceId, trigger: "connect" }, now);
    await recordStats(db, first.runId, "Observation:lab", { fetched: 3, inserted: 2, superseded: 1, unchanged: 0, removed: 0 });
    await finishRun(db, first.runId, now);
    const second = await startRun(db, { userId, sourceId, trigger: "scheduled" }, at(1));
    await failRun(db, second.runId, "reconnect", at(2));
    await failRun(db, second.runId, "reconnect", at(3)); // already ended: not recorded twice

    const syncs = (await events()).filter((e) => e.action === "sync").map((e) => e.detail);
    expect(syncs).toEqual([
      { trigger: "connect", status: "ok", inserted: 3 },
      { trigger: "scheduled", status: "failed", reason: "reconnect" },
    ]);
    expect(await db.select().from(syncRun).where(eq(syncRun.sourceId, sourceId))).toHaveLength(2);
  });

  it("never holds tokens, patient ids or organization names", async () => {
    const { sourceId } = await connect();
    const run = await startRun(db, { userId, sourceId, trigger: "connect" }, now);
    await finishRun(db, run.runId, now);
    const stored = JSON.stringify(await db.select().from(auditEvent).where(eq(auditEvent.userId, userId)));
    for (const secret of ["secret-at", "secret-rt", "patient-123", "Lakeside", "lakeside.example"]) expect(stored).not.toContain(secret);
  });
});
