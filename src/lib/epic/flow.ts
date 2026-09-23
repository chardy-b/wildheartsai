import { seal, unseal } from "@/lib/crypto/seal";

export const FLOW_COOKIE = "wh_epic_flow";
export const FLOW_TTL_SECONDS = 600;

export type Flow = {
  state: string;
  verifier: string;
  fhirBaseUrl: string;
  organizationName: string;
  tokenEndpoint: string;
  createdAt: number;
};

export function encodeFlow(flow: Flow, key: Buffer): string {
  return seal(JSON.stringify(flow), key);
}

export function decodeFlow(value: string | undefined, key: Buffer, now: Date): Flow | null {
  if (!value) return null;
  try {
    const flow = JSON.parse(unseal(value, key)) as Flow;
    if (now.getTime() - flow.createdAt > FLOW_TTL_SECONDS * 1000) return null;
    return flow;
  } catch {
    return null;
  }
}
