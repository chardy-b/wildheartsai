import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { EpicError } from "@/lib/epic/errors";
import type { Resource } from "@/lib/fhir/types";
import { SYNC_QUERIES } from "@/lib/sync/plan";
import type { SyncDeps } from "@/lib/sync/run";

// Recorded Epic sandbox responses (scripts/capture-sandbox.ts), replayed as a fake FHIR
// server so tests run the real sync against realistic data with no network or sign-in.
// Only Epic's published sample patients are ever captured: made-up people, not PHI.

export type RecordedError = { error: { status?: number; code?: string } };

export type SandboxFixture = {
  capturedAt: string;
  fhirBaseUrl: string;
  patientId: string;
  // By sync query key ('Observation:lab'), what the search returned or how it failed.
  searches: Record<string, { resources: Resource[]; truncated: boolean } | RecordedError>;
  // By address, what each read returned or how it failed: notes' Binary attachments
  // ('Binary/…') and the resources records point to ('Practitioner/…').
  reads: Record<string, Resource | RecordedError>;
};

export const FIXTURE_DIR = path.join(process.cwd(), "src/test/fixtures/epic-sandbox");

export function loadFixtures(): { name: string; fixture: SandboxFixture }[] {
  return readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({ name: file.replace(/\.json$/, ""), fixture: JSON.parse(readFileSync(path.join(FIXTURE_DIR, file), "utf8")) }));
}

function isError(value: unknown): value is RecordedError {
  return typeof value === "object" && value !== null && "error" in value;
}

function replayError({ error }: RecordedError): EpicError {
  return new EpicError("fhir", error.status, error.code);
}

// `lastUpdated`: whether the fake honours _lastUpdated (filters by meta.lastUpdated) or ignores it.
export function replayEpic(fixture: SandboxFixture, options: { lastUpdated: "honour" | "ignore" } = { lastUpdated: "honour" }) {
  const searches: string[] = [];
  const reads: string[] = [];

  const search: SyncDeps["search"] = async ({ path: requested }) => {
    searches.push(requested);
    const [base, since] = requested.split("&_lastUpdated=");
    const query = SYNC_QUERIES.find((q) => q.path(fixture.patientId) === base);
    const recorded = query ? fixture.searches[query.key] : undefined;
    if (!recorded) throw new EpicError("fhir", 404);
    if (isError(recorded)) throw replayError(recorded);
    let resources = recorded.resources;
    if (since && options.lastUpdated === "honour") {
      const after = new Date(decodeURIComponent(since).slice(2)).getTime();
      resources = resources.filter((r) => Date.parse((r as { meta?: { lastUpdated?: string } }).meta?.lastUpdated ?? "") > after);
    }
    return { resources, truncated: since ? false : recorded.truncated };
  };

  const read: SyncDeps["read"] = async ({ path: address }) => {
    reads.push(address);
    const recorded = fixture.reads[address];
    if (!recorded) throw new EpicError("fhir", 404);
    if (isError(recorded)) throw replayError(recorded);
    return recorded;
  };

  return { search, read, searches, reads };
}

// Searches that succeeded, by query key.
export function recordedResults(fixture: SandboxFixture): Record<string, Resource[]> {
  return Object.fromEntries(
    Object.entries(fixture.searches).flatMap(([key, value]) => (isError(value) ? [] : [[key, value.resources]])),
  );
}

export function isRecordedError(value: unknown): value is RecordedError {
  return isError(value);
}
