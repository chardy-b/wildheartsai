import { createHash } from "node:crypto";
import type { Resource } from "@/lib/fhir/types";
import type { Persona } from "./personas";

// A small client for the parts of Metriport's Medical API the sandbox experience needs.
// Sandbox only: the base address is fixed, so a misconfigured environment can never reach
// real patients. Response bodies are never logged.

export const METRIPORT_SANDBOX_URL = "https://api.sandbox.metriport.com/medical/v1";
// Metriport's published sandbox NPI.
const SANDBOX_NPI = "1234567893";
const TIMEOUT_MS = 30_000;

export class MetriportError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly code: string,
  ) {
    super(`Metriport request failed (${status ?? code})`);
    this.name = "MetriportError";
  }
}

export type QueryStatus = "processing" | "completed" | "failed";
export type DocumentQuery = { requestId?: string; download?: { status?: QueryStatus }; convert?: { status?: QueryStatus } };
export type FhirBundle = { resourceType: "Bundle"; entry?: { resource?: Resource }[] };

export type MetriportClient = {
  facilityId(): Promise<string>;
  createPatient(persona: Persona, facilityId: string, externalId: string): Promise<{ id: string }>;
  startDocumentQuery(patientId: string, facilityId: string): Promise<DocumentQuery>;
  documentQueryStatus(patientId: string): Promise<DocumentQuery>;
  consolidated(patientId: string): Promise<FhirBundle>;
};

// Stable per person and persona, so reconnecting finds the same Metriport patient.
export function externalIdFor(userId: string, persona: Persona): string {
  return `wh-${createHash("sha256").update(`${userId}:${persona.id}`).digest("hex").slice(0, 32)}`;
}

export function createMetriportClient(apiKey: string, fetchImpl: typeof fetch = fetch): MetriportClient {
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${METRIPORT_SANDBOX_URL}${path}`, {
        method,
        headers: { "x-api-key": apiKey, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      throw new MetriportError(undefined, "network");
    }
    if (!response.ok) throw new MetriportError(response.status, "http");
    try {
      return (await response.json()) as T;
    } catch {
      throw new MetriportError(response.status, "bad_response");
    }
  }

  return {
    async facilityId() {
      const listed = await call<{ facilities?: { id: string }[] } | { id: string }[]>("GET", "/facility");
      const facilities = Array.isArray(listed) ? listed : (listed.facilities ?? []);
      if (facilities[0]?.id) return facilities[0].id;
      const created = await call<{ id: string }>("POST", "/facility", {
        name: "Wild Hearts sandbox facility",
        npi: SANDBOX_NPI,
        active: true,
        address: { addressLine1: "2261 Market Street", city: "San Francisco", state: "CA", zip: "94114", country: "USA" },
      });
      return created.id;
    },
    createPatient(persona, facilityId, externalId) {
      return call<{ id: string }>("POST", `/patient?facilityId=${encodeURIComponent(facilityId)}`, {
        firstName: persona.firstName,
        lastName: persona.lastName,
        dob: persona.dob,
        genderAtBirth: persona.genderAtBirth,
        address: [persona.address],
        contact: [{ phone: "1234567899", email: "sandbox@example.com" }],
        externalId,
      });
    },
    startDocumentQuery(patientId, facilityId) {
      return call("POST", `/document/query?patientId=${encodeURIComponent(patientId)}&facilityId=${encodeURIComponent(facilityId)}`, {});
    },
    documentQueryStatus(patientId) {
      return call("GET", `/document/query?patientId=${encodeURIComponent(patientId)}`);
    },
    consolidated(patientId) {
      return call("GET", `/patient/${encodeURIComponent(patientId)}/consolidated`);
    },
  };
}

// The pull from the networks is finished once the download stage is. (The sandbox's status has no
// `convert` stage, so only the download decides.)
export function queryState(status: DocumentQuery): QueryStatus {
  return status.download?.status ?? "completed";
}
