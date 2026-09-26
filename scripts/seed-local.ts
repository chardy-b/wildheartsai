// Creates a signed-up, verified and onboarded test account in the LOCAL database, with
// stored records from two made-up organizations (one connected, one disconnected with
// kept records, and an amended lab). For manual and automated testing of the dashboard
// and connections pages without going through Epic.
//
//   npm run db:migrate:local
//   npm run db:seed
//
// Sign in at http://localhost:3000/sign-in with the account below. These are local test
// values, not secrets. The seed only ever opens the local D1 in .wrangler/state (remote
// bindings are off), the same one `npm run dev` and `npm run preview` use.
// Re-running it deletes the account and everything stored for it, then recreates it.

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

export const TEST_EMAIL = "test@wildhearts.localhost";
export const TEST_PASSWORD = "local-test-password";
const TEST_USER_ID = "local_test_user";

async function main() {
  const { hashPassword } = await import("better-auth/crypto");
  const { eq } = await import("drizzle-orm");
  const { drizzle } = await import("drizzle-orm/d1");
  const { getPlatformProxy } = await import("wrangler");
  const { keyFromBase64 } = await import("@/lib/crypto/seal");
  const { userKeysFor } = await import("@/lib/crypto/user-keys");
  const schema = await import("@/lib/db/schema");
  const { deleteConnection, saveConnection } = await import("@/lib/epic/connections");
  const { env } = await import("@/lib/env");
  const { CONSENT_VERSION } = await import("@/lib/onboarding");
  const { runSyncJob } = await import("@/lib/sync/job");
  const { startRun } = await import("@/lib/sync/run");
  type Db = import("@/lib/db/types").Db;
  type Resource = import("@/lib/fhir/types").Resource;
  type SyncDeps = import("@/lib/sync/run").SyncDeps;

  const config = env();
  const platform = await getPlatformProxy<CloudflareEnv>({ remoteBindings: false });
  const db: Db = drizzle(platform.env.DB, { schema });
  const tokenKey = keyFromBase64(config.TOKEN_ENCRYPTION_KEY);
  const kek = keyFromBase64(config.RECORDS_ENCRYPTION_KEY);
  const now = new Date();
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const day = (days: number) => daysAgo(days).toISOString().slice(0, 10);

  // Start clean: deleting the user cascades to sessions, sources, records and keys.
  await db.delete(schema.user).where(eq(schema.user.id, TEST_USER_ID));
  await db.insert(schema.user).values({
    id: TEST_USER_ID,
    name: "Local Tester",
    email: TEST_EMAIL,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.account).values({
    id: `${TEST_USER_ID}_credential`,
    accountId: TEST_USER_ID,
    providerId: "credential",
    userId: TEST_USER_ID,
    password: await hashPassword(TEST_PASSWORD),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.profile).values({
    userId: TEST_USER_ID,
    preferredName: "Tester",
    consentVersion: CONSENT_VERSION,
    consentedAt: now,
    onboardedAt: now,
  });

  const keys = await userKeysFor(db, kek, TEST_USER_ID, now);

  async function connect(organizationName: string, fhirBaseUrl: string): Promise<string> {
    const { sourceId } = await saveConnection(
      db,
      tokenKey,
      {
        userId: TEST_USER_ID,
        fhirBaseUrl,
        organizationName,
        tokenEndpoint: `${fhirBaseUrl}/oauth2/token`,
        // Placeholder tokens: Refresh and note text fail against these made-up organizations.
        tokens: { accessToken: "seed", refreshToken: "seed", expiresAt: now, scope: "seed", patientId: "seed-patient" },
      },
      now,
    );
    return sourceId;
  }

  // Imports through the real sync job, answering each search from `byType`.
  async function importInto(sourceId: string, organizationName: string, byType: Record<string, Resource[]>) {
    const { runId } = await startRun(db, { userId: TEST_USER_ID, sourceId, trigger: "connect" }, now);
    const search: SyncDeps["search"] = async ({ path }) => ({ resources: byType[path.split("&_lastUpdated=")[0]] ?? [], truncated: false });
    const deps: SyncDeps = { db, keys, now: () => new Date(), accessToken: async () => "seed", search };
    const source = { runId, userId: TEST_USER_ID, sourceId, organizationName, fhirBaseUrl: "https://seed.invalid", patientId: "seed-patient" };
    await runSyncJob({ runId, userId: TEST_USER_ID, sourceId }, (_id, work) => work(), {
      db,
      now: () => new Date(),
      load: async () => ({ deps, source }),
    });
  }

  const q = (resource: string, extra = "") => `${resource}?patient=seed-patient${extra}`;
  const lab = (id: string, when: string, text: string, value: number, unit: string): Resource =>
    ({
      resourceType: "Observation",
      id,
      status: "final",
      category: [{ coding: [{ code: "laboratory" }] }],
      code: { text },
      effectiveDateTime: when,
      valueQuantity: { value, unit },
    }) as Resource;

  const north = await connect("North Clinic (seed)", "https://north.seed.invalid/FHIR/R4");
  const northRecords = (a1c: number): Record<string, Resource[]> => ({
    [q("Condition", "&category=problem-list-item")]: [
      { resourceType: "Condition", id: "c1", code: { text: "Asthma" }, onsetDateTime: day(900), clinicalStatus: { coding: [{ code: "active" }] } } as Resource,
      { resourceType: "Condition", id: "c2", code: { text: "Seasonal allergies" } } as Resource,
    ],
    [q("MedicationRequest")]: [
      { resourceType: "MedicationRequest", id: "m1", status: "active", medicationCodeableConcept: { text: "Albuterol inhaler" }, authoredOn: day(400) } as Resource,
    ],
    [q("AllergyIntolerance")]: [{ resourceType: "AllergyIntolerance", id: "a1", code: { text: "Penicillin" }, recordedDate: day(1200) } as Resource],
    [q("Observation", "&category=laboratory")]: [
      lab("l1", day(10), "Hemoglobin A1c", a1c, "%"),
      lab("l2", day(200), "LDL cholesterol", 96, "mg/dL"),
    ],
    [q("Observation", "&category=vital-signs")]: [
      { resourceType: "Observation", id: "v1", status: "final", code: { text: "Body weight" }, effectiveDateTime: day(10), valueQuantity: { value: 70, unit: "kg" } } as Resource,
    ],
    [q("Immunization")]: [{ resourceType: "Immunization", id: "i1", status: "completed", vaccineCode: { text: "Influenza vaccine" }, occurrenceDateTime: day(60) } as Resource],
    [q("Encounter")]: [
      { resourceType: "Encounter", id: "e1", status: "finished", type: [{ text: "Office visit" }], period: { start: `${day(10)}T15:00:00Z` } } as Resource,
    ],
    [q("DocumentReference", "&category=clinical-note")]: [
      {
        resourceType: "DocumentReference",
        id: "d1",
        status: "current",
        type: { text: "Progress note" },
        date: `${day(10)}T16:00:00Z`,
        context: { encounter: [{ reference: "Encounter/e1" }] },
        content: [{ attachment: { contentType: "text/plain", url: "Binary/seed-note" } }],
      } as Resource,
    ],
  });
  await importInto(north, "North Clinic (seed)", northRecords(6.1));
  // A second import with a changed value, so the A1c shows as amended with its earlier version.
  await importInto(north, "North Clinic (seed)", northRecords(5.9));

  const south = await connect("South Hospital (seed)", "https://south.seed.invalid/FHIR/R4");
  await importInto(south, "South Hospital (seed)", {
    [q("Observation", "&category=laboratory")]: [lab("s1", day(700), "Lipid panel", 180, "mg/dL")],
    [q("Procedure")]: [{ resourceType: "Procedure", id: "p1", status: "completed", code: { text: "Appendectomy" }, performedDateTime: day(3000) } as Resource],
  });
  const [southConnection] = await db.select().from(schema.epicConnection).where(eq(schema.epicConnection.sourceId, south));
  await deleteConnection(db, TEST_USER_ID, southConnection.id, now);

  await platform.dispose();
  console.log(`Seeded ${TEST_EMAIL}: North Clinic connected (amended A1c), South Hospital disconnected with records kept.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
