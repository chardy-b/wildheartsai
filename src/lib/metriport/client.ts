import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
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

const patientSchema = z.object({ id: z.string().min(1) });
const progressSchema = z.object({ status: z.enum(["processing", "completed", "failed"]) });
const querySchema = z.object({ requestId: z.string().optional(), download: progressSchema.optional(), convert: progressSchema.optional() });
const bundleSchema = z.looseObject({
  resourceType: z.literal("Bundle"),
  entry: z.array(z.looseObject({ resource: z.looseObject({ resourceType: z.string().min(1), id: z.string().min(1) }) })).optional(),
  link: z.array(z.object({ relation: z.string() })).optional(),
}).refine((bundle) => !bundle.link?.some((link) => link.relation === "next"));

function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  // Never propagate validation errors containing response data.
  if (!result.success) throw new MetriportError(undefined, "bad_response");
  return result.data;
}

export type MetriportClient = {
  facilityId(): Promise<string>;
  findPatient(externalId: string): Promise<{ id: string } | undefined>;
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
        redirect: "error",
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
      const listed = validated(z.union([z.array(patientSchema), z.object({ facilities: z.array(patientSchema) })]), await call("GET", "/facility"));
      const facilities = Array.isArray(listed) ? listed : listed.facilities;
      if (facilities[0]?.id) return facilities[0].id;
      const created = await call<{ id: string }>("POST", "/facility", {
        name: "Wild Hearts sandbox facility",
        npi: SANDBOX_NPI,
        active: true,
        address: { addressLine1: "2261 Market Street", city: "San Francisco", state: "CA", zip: "94114", country: "USA" },
      });
      return validated(patientSchema, created).id;
    },
    async findPatient(externalId) {
      try {
        return validated(patientSchema, await call("GET", `/patient/external-id?externalId=${encodeURIComponent(externalId)}`));
      } catch (error) {
        if (error instanceof MetriportError && error.status === 404) return undefined;
        throw error;
      }
    },
    async createPatient(persona, facilityId, externalId) {
      return validated(patientSchema, await call("POST", `/patient?facilityId=${encodeURIComponent(facilityId)}`, {
        firstName: persona.firstName,
        lastName: persona.lastName,
        dob: persona.dob,
        genderAtBirth: persona.genderAtBirth,
        address: [persona.address],
        contact: [{ phone: "1234567899", email: "sandbox@example.com" }],
        externalId,
      }));
    },
    startDocumentQuery(patientId, facilityId) {
      return call("POST", `/document/query?patientId=${encodeURIComponent(patientId)}&facilityId=${encodeURIComponent(facilityId)}`, {});
    },
    async documentQueryStatus(patientId) {
      return validated(querySchema, await call("GET", `/document/query?patientId=${encodeURIComponent(patientId)}`));
    },
    async consolidated(patientId) {
      return validated(bundleSchema, await call("GET", `/patient/${encodeURIComponent(patientId)}/consolidated`)) as FhirBundle;
    },
  };
}

// The sandbox can omit stages. When conversion is reported, it must finish too.
export function queryState(status: DocumentQuery): QueryStatus {
  const stages = [status.download?.status, status.convert?.status];
  if (stages.includes("failed")) return "failed";
  if (stages.includes("processing")) return "processing";
  return "completed";
}

// Disconnect deletes the local link, not the upstream sample patient. Recover it on reconnect
// and after a failed save; also tolerate another connect request winning the create race.
export async function findOrCreatePatient(client: MetriportClient, persona: Persona, facilityId: string, externalId: string): Promise<{ id: string }> {
  const existing = await client.findPatient(externalId);
  if (existing) return existing;
  try {
    return await client.createPatient(persona, facilityId, externalId);
  } catch (error) {
    if (error instanceof MetriportError && error.status === 409) {
      const concurrent = await client.findPatient(externalId);
      if (concurrent) return concurrent;
    }
    throw error;
  }
}
