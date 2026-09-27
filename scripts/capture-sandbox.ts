// Records what Epic's sandbox returns for a connected sample patient, as a test fixture
// that `src/lib/sync/sandbox-replay.test.ts` replays through the real sync. Lets tests
// (and agents) exercise realistic Epic data with no network or MyChart sign-in.
//
//   1. npm run db:local / db:migrate, then `npm run dev`, sign in locally and connect
//      "Epic sandbox (sample patients)" with one of Epic's published sample patients.
//   2. npm run qa:capture -- --name camila-lopez [--email you@example.com]
//
// Writes src/test/fixtures/epic-sandbox/<name>.json. Only Epic's sandbox is ever captured:
// its patients are made up, so the file is safe to commit. Real health systems are refused.
// The access token is refreshed automatically if it has expired.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { getConnectionSecrets } = await import("@/lib/epic/connections");
  const { isSampleData } = await import("@/lib/epic/directory");
  const { EpicError, ReconnectRequiredError } = await import("@/lib/epic/errors");
  const { accessTokenFor, tokenKey } = await import("@/lib/epic/server");
  const { fhirRead, fhirSearchBounded } = await import("@/lib/fhir/client");
  const { noteAttachment } = await import("@/lib/fhir/links");
  const { SYNC_MAX_PAGES, SYNC_MAX_RESOURCES, SYNC_QUERIES } = await import("@/lib/sync/plan");
  const { FIXTURE_DIR } = await import("@/test/epic-replay");
  type SandboxFixture = import("@/test/epic-replay").SandboxFixture;

  const name = arg("name");
  if (!name || !/^[a-z0-9-]+$/.test(name)) throw new Error("Pass --name, lowercase letters, digits and dashes (for example --name camila-lopez)");

  // The account whose sandbox connection to record: --email, or the only account that has one.
  const email = arg("email");
  const users = email
    ? await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email))
    : await db.selectDistinct({ id: schema.epicConnection.userId }).from(schema.epicConnection);
  const candidates = [];
  for (const { id } of users) {
    for (const connection of await getConnectionSecrets(db, tokenKey(), id)) {
      if (isSampleData(connection)) candidates.push(connection);
    }
  }
  if (candidates.length === 0) throw new Error("No Epic sandbox connection found. Connect the sandbox locally first (see the top of this file).");
  if (candidates.length > 1) throw new Error("More than one sandbox connection found; pass --email to choose the account.");
  const connection = candidates[0];
  // Belt and braces: never record a real health system.
  if (!isSampleData(connection)) throw new Error("Refusing to capture a connection that isn't Epic's sandbox");

  // Facts about the connection, never the tokens themselves: enough to tell why access can't be renewed.
  const scopes = connection.scope.split(/\s+/).filter(Boolean);
  const expired = connection.accessTokenExpiresAt.getTime() <= Date.now();
  console.log(`Sandbox connection: access token ${expired ? "expired" : "valid until"} ${connection.accessTokenExpiresAt.toISOString()}`);
  console.log(`  refresh token: ${connection.refreshToken ? "yes" : "no"}; offline_access granted: ${scopes.includes("offline_access") ? "yes" : "no"}\n`);

  let accessToken: string;
  try {
    accessToken = await accessTokenFor(connection);
  } catch (error) {
    if (!(error instanceof ReconnectRequiredError)) throw error;
    throw new Error(
      connection.refreshToken
        ? "Epic refused to renew access (the refresh token has expired or was revoked). Reconnect the sandbox on the local Connections page, then run this again."
        : "Access has expired and Epic didn't issue a refresh token for this connection, so it can't be renewed. " +
            "Reconnect the sandbox and run this within the hour. For connections that stay usable, the Epic app registration " +
            "needs refresh tokens enabled and the offline_access scope granted.",
    );
  }

  const recordError = (error: unknown) => {
    if (error instanceof ReconnectRequiredError) throw error;
    return { error: error instanceof EpicError ? { status: error.status, code: error.code } : { code: "network" } };
  };

  const fixture: SandboxFixture = {
    capturedAt: new Date().toISOString(),
    fhirBaseUrl: connection.fhirBaseUrl,
    patientId: connection.patientId,
    searches: {},
    reads: {},
  };

  for (const query of SYNC_QUERIES) {
    try {
      fixture.searches[query.key] = await fhirSearchBounded({
        baseUrl: connection.fhirBaseUrl,
        path: query.path(connection.patientId),
        resourceType: query.resourceType,
        accessToken,
        maxPages: SYNC_MAX_PAGES,
        maxResources: SYNC_MAX_RESOURCES,
      });
    } catch (error) {
      fixture.searches[query.key] = recordError(error);
    }
    const result = fixture.searches[query.key];
    console.log(`${query.key.padEnd(34)} ${"error" in result ? `error ${result.error.status ?? result.error.code}` : `${result.resources.length}${result.truncated ? " (truncated)" : ""}`}`);
  }

  // A capture where nothing worked (no network, expired access) would only test failure.
  const succeeded = SYNC_QUERIES.filter((q) => !q.optional && !("error" in fixture.searches[q.key]));
  if (succeeded.length === 0) {
    throw new Error("Every search failed, so nothing was written. Check your network, or reconnect the sandbox locally, and try again.");
  }

  const notes = fixture.searches["DocumentReference:note"];
  for (const note of notes && !("error" in notes) ? notes.resources : []) {
    const attachment = noteAttachment(note);
    if (!attachment || fixture.reads[attachment.url]) continue;
    try {
      fixture.reads[attachment.url] = await fhirRead({ baseUrl: connection.fhirBaseUrl, path: attachment.url, accessToken });
    } catch (error) {
      fixture.reads[attachment.url] = recordError(error);
    }
  }
  console.log(`${"note text".padEnd(34)} ${Object.keys(fixture.reads).length}`);

  const file = path.join(FIXTURE_DIR, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(process.cwd(), file)}. Run \`npx vitest run src/lib/sync/sandbox-replay.test.ts\`, then commit it.`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    // Database errors wrap the useful part ("connection refused", "relation does not exist") in `cause`.
    const cause = error instanceof Error && error.cause instanceof Error ? `\n  Cause: ${error.cause.message}` : "";
    console.error(`${error instanceof Error ? error.message : String(error)}${cause}`);
    if (/Failed query/.test(String(error))) {
      console.error("  Is the local database running (`npm run db:local`, in its own terminal) and migrated (`npm run db:migrate`)?");
    }
    process.exit(1);
  },
);
