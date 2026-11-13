import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EPIC_SANDBOX } from "@/lib/epic/directory";
import { EpicError, ReconnectRequiredError } from "@/lib/epic/errors";
import { getConnectionForSource, saveConnection } from "../src/data/connections";
import type { Bindings } from "../src/env";
import { accessTokenFor } from "../src/epic/token-refresher";
import { clearAll, person, tokenKey, tokens } from "./helpers";

// Refresh tokens rotate: spending one twice forces a reconnect. These check that concurrent
// requests refresh once and share the result, through one Durable Object per connection.
const TOKEN_ENDPOINT = "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token";
const bindings = env as unknown as Bindings;

let calls: URLSearchParams[] = [];
let respond: () => Response;

beforeEach(async () => {
  await clearAll();
  calls = [];
  respond = () => Response.json({ access_token: `access-${calls.length}`, token_type: "Bearer", expires_in: 3600, scope: "openid", refresh_token: `refresh-${calls.length}` });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input) !== TOKEN_ENDPOINT) return new Response("unexpected", { status: 500 });
    calls.push(new URLSearchParams(String(init?.body)));
    // Slow enough that the concurrent requests overlap.
    await new Promise((r) => setTimeout(r, 50));
    return respond();
  });
});
afterEach(() => vi.restoreAllMocks());

async function expired(userId: string) {
  const scope = await person(userId);
  const { sourceId } = await saveConnection(scope, tokenKey, { fhirBaseUrl: EPIC_SANDBOX.fhirBaseUrl, organizationName: "Sandbox", tokenEndpoint: TOKEN_ENDPOINT, tokens: tokens("access-0", "refresh-0", -60_000) }, new Date());
  return { scope, sourceId, connection: (await getConnectionForSource(scope, tokenKey, sourceId))! };
}

describe("TokenRefresher", () => {
  it("refreshes once for concurrent requests, and stores the rotated tokens", async () => {
    const { scope, sourceId, connection } = await expired("a");
    const results = await Promise.all(Array.from({ length: 5 }, () => accessTokenFor(bindings, "a", connection)));
    expect(results).toEqual(Array(5).fill("access-1"));
    expect(calls).toHaveLength(1);
    expect(calls[0].get("refresh_token")).toBe("refresh-0");
    expect(await getConnectionForSource(scope, tokenKey, sourceId)).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1" });

    // A caller still holding the old copy gets the stored token, without spending refresh-0 again.
    expect(await accessTokenFor(bindings, "a", connection)).toBe("access-1");
    expect(calls).toHaveLength(1);
  });

  it("keeps the reconnect signal across the Durable Object boundary", async () => {
    const { connection } = await expired("a");
    respond = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    const error = await accessTokenFor(bindings, "a", connection).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReconnectRequiredError);
    expect((error as ReconnectRequiredError).reason).toBe("refresh_rejected");
  });

  it("refuses someone else's connection", async () => {
    const { connection } = await expired("a");
    await person("b");
    const error = await accessTokenFor(bindings, "b", connection).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EpicError);
    expect((error as EpicError).code).toBe("connection_unavailable");
    expect(calls).toHaveLength(0);
  });

  it("uses a fresh stored token without asking Epic", async () => {
    const scope = await person("a");
    const { sourceId } = await saveConnection(scope, tokenKey, { fhirBaseUrl: EPIC_SANDBOX.fhirBaseUrl, organizationName: "Sandbox", tokenEndpoint: TOKEN_ENDPOINT, tokens: tokens("access-live", "refresh-0", 3600_000) }, new Date());
    expect(await accessTokenFor(bindings, "a", (await getConnectionForSource(scope, tokenKey, sourceId))!)).toBe("access-live");
    expect(calls).toHaveLength(0);
  });
});
