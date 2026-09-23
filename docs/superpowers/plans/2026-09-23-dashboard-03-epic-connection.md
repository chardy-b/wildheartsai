# Dashboard 03: Epic Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in, onboarded person can pick a health system, sign in on its MyChart page, and come back with a stored, encrypted Epic connection they can later disconnect.

**Architecture:** SMART App Launch (standalone, patient) with authorization code + PKCE. Wild Hearts is a confidential client that authenticates to Epic's token endpoint with a signed JWT (`private_key_jwt`, RS384); its public key is served at `/api/epic/jwks`. `/api/epic/authorize` checks the requested FHIR base URL against the org directory, discovers the endpoints, stores `state` + PKCE verifier in a sealed cookie, and redirects. `/api/epic/callback` validates state, exchanges the code, and saves tokens and the patient ID, sealed with AES-256-GCM, in `epic_connection`. Every piece of logic lives in `src/lib/epic/*` as small functions with injected `fetch`, so it can be unit tested; the route handlers are thin.

**Tech Stack:** Node `crypto` (AES-256-GCM, SHA-256), `jose` 6 (JWT signing, JWKS), Zod 4, Drizzle, Next.js 16 route handlers and server actions, Vitest + PGlite.

**Spec:** `docs/superpowers/plans/2026-09-23-dashboard-roadmap.md` (read **Security rules** and **Epic app registration**), `docs/creative-direction.md`. Requires plans 01 and 02 merged.

## Global Constraints

- Everything in plan 01's Global Constraints applies.
- `EPIC_ENVIRONMENT` stays `sandbox` in every environment until the roadmap's production gate passes.
- Tokens, refresh tokens and the patient FHIR ID are sealed before they reach the database and never leave server code. They never appear in logs, URLs, error messages or props passed to client components.
- `/api/epic/authorize` accepts only FHIR base URLs present in the directory; anything else gets a 400.
- The flow cookie is `httpOnly`, `SameSite=Lax`, `Secure` in production, `Path=/api/epic`, and lasts 10 minutes.
- PKCE method: `S256` only. Client assertion lifetime: 240 seconds. Access tokens count as expired 60 seconds early.
- Requested scopes are exactly `EPIC_SCOPES` (Task 6). The connections page lists them in plain language, which is the landing page's "only what's needed" promise.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/crypto/seal.ts` | AES-256-GCM `seal` / `unseal`, `keyFromBase64` |
| `src/lib/epic/errors.ts` | `EpicError`, `ReconnectRequiredError` |
| `src/lib/epic/pkce.ts` | PKCE pair, `state`, constant-time compare |
| `src/lib/epic/flow.ts` | Sealed flow cookie encode/decode |
| `src/lib/epic/directory.ts` | Org directory: sandbox entry, Epic endpoints list, search, allowlist lookup |
| `src/lib/epic/smart.ts` | `.well-known/smart-configuration` discovery |
| `src/lib/epic/client-assertion.ts` | JWT client assertion, public JWKS |
| `src/lib/epic/authorize.ts` | `EPIC_SCOPES`, `SCOPE_LABELS`, authorize URL builder |
| `src/lib/epic/tokens.ts` | Code exchange and refresh |
| `src/lib/db/epic-schema.ts` | `epic_connection` table |
| `src/lib/epic/connections.ts` | Encrypted connection repository |
| `src/lib/epic/callback.ts` | `completeAuthorization()` decision logic |
| `src/lib/epic/access.ts` | `freshAccessToken()` refresh-if-needed logic |
| `src/lib/epic/server.ts` | Server-only wiring: keys from env, `accessTokenFor()` |
| `src/app/api/epic/{authorize,callback,jwks}/route.ts` | Thin route handlers |
| `src/app/(app)/app/connections/*` | Connections page, disconnect action, styles |
| `src/components/app/OrgSearch.tsx`, `FinishLater.tsx` | Health-system picker, "do this later" button |
| `scripts/generate-epic-key.mjs` | One-off key pair generator |

---

### Task 1: Environment additions and token sealing

**Files:**
- Create: `src/lib/crypto/seal.ts`, `src/lib/crypto/seal.test.ts`, `src/lib/epic/errors.ts`
- Modify: `src/lib/env.ts`, `src/lib/env.test.ts`, `src/test/setup.ts`, `.env.example`

**Interfaces:**
- Produces: `seal(plaintext: string, key: Buffer): string`, `unseal(sealed: string, key: Buffer): string`, `keyFromBase64(value: string): Buffer`; env fields `EPIC_ENVIRONMENT: "sandbox" | "production"`, `EPIC_CLIENT_ID`, `EPIC_REDIRECT_URI`, `EPIC_PRIVATE_JWK` (JSON string), `EPIC_RETIRING_PUBLIC_JWK?` (JSON string), `TOKEN_ENCRYPTION_KEY` (base64, 32 bytes); `class EpicError(stage, status?, code?)`, `class ReconnectRequiredError`.

- [ ] **Step 1: Write the failing test `src/lib/crypto/seal.test.ts`**

```ts
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keyFromBase64, seal, unseal } from "./seal";

const key = randomBytes(32);

describe("seal", () => {
  it("round-trips text", () => {
    expect(unseal(seal("access-token-123", key), key)).toBe("access-token-123");
  });

  it("uses a fresh IV every time", () => {
    expect(seal("same", key)).not.toBe(seal("same", key));
  });

  it("does not contain the plaintext", () => {
    expect(seal("patient-abc", key)).not.toContain("patient-abc");
  });

  it("rejects tampered ciphertext", () => {
    const [prefix, iv, body, tag] = seal("secret", key).split(".");
    const flipped = Buffer.from(body, "base64url");
    flipped[0] ^= 1;
    expect(() => unseal([prefix, iv, flipped.toString("base64url"), tag].join("."), key)).toThrow();
  });

  it("rejects the wrong key", () => {
    expect(() => unseal(seal("secret", key), randomBytes(32))).toThrow();
  });
});

describe("keyFromBase64", () => {
  it("accepts 32 bytes and rejects anything else", () => {
    expect(keyFromBase64(randomBytes(32).toString("base64")).length).toBe(32);
    expect(() => keyFromBase64(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/crypto/seal.test.ts`
Expected: FAIL — cannot resolve `./seal`.

- [ ] **Step 3: Implement `src/lib/crypto/seal.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Format: v1.<iv>.<ciphertext>.<auth tag>, each part base64url.
const PREFIX = "v1";

export function keyFromBase64(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes, base64-encoded");
  return key;
}

export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64url"), body.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

export function unseal(sealed: string, key: Buffer): string {
  const [prefix, iv, body, tag] = sealed.split(".");
  if (prefix !== PREFIX || iv === undefined || body === undefined || tag === undefined) {
    throw new Error("Unrecognized sealed value");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 4: Implement `src/lib/epic/errors.ts`**

```ts
export type EpicStage = "discovery" | "token" | "refresh" | "fhir";

// Messages carry only the stage, HTTP status and OAuth error code: never tokens or patient data.
export class EpicError extends Error {
  constructor(
    readonly stage: EpicStage,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(`Epic ${stage} failed${status ? ` (${status})` : ""}${code ? `: ${code}` : ""}`);
    this.name = "EpicError";
  }
}

export class ReconnectRequiredError extends Error {
  constructor() {
    super("The Epic connection needs to be reconnected");
    this.name = "ReconnectRequiredError";
  }
}
```

- [ ] **Step 5: Run the seal tests to verify they pass**

Run: `npx vitest run src/lib/crypto/seal.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Extend the environment schema**

In `src/lib/env.ts`, add these fields inside `z.object({ … })`:

```ts
  EPIC_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  EPIC_CLIENT_ID: z.string().min(1),
  EPIC_REDIRECT_URI: z.url(),
  EPIC_PRIVATE_JWK: z.string().min(2),
  EPIC_RETIRING_PUBLIC_JWK: z.string().min(2).optional(),
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine((value) => Buffer.from(value, "base64").length === 32, "TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded"),
```

In `src/lib/env.test.ts`, add to the `valid` object:

```ts
  EPIC_CLIENT_ID: "client-123",
  EPIC_REDIRECT_URI: "http://localhost:3000/api/epic/callback",
  EPIC_PRIVATE_JWK: '{"kty":"RSA"}',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
```

and add this test inside `describe("parseEnv", …)`:

```ts
  it("defaults to the Epic sandbox and rejects a short encryption key", () => {
    expect(parseEnv(valid).EPIC_ENVIRONMENT).toBe("sandbox");
    expect(() => parseEnv({ ...valid, TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") })).toThrow(
      /TOKEN_ENCRYPTION_KEY/,
    );
  });
```

Append to `src/test/setup.ts`:

```ts
process.env.EPIC_ENVIRONMENT ??= "sandbox";
process.env.EPIC_CLIENT_ID ??= "test-client-id";
process.env.EPIC_REDIRECT_URI ??= "http://localhost:3000/api/epic/callback";
process.env.EPIC_PRIVATE_JWK ??= "{}";
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32).toString("base64");
```

In `.env.example`, replace the Epic block with:

```bash
# Epic SMART on FHIR. Keep EPIC_ENVIRONMENT=sandbox until the production gate passes.
EPIC_ENVIRONMENT=sandbox
EPIC_CLIENT_ID=replace-with-epic-non-production-client-id
EPIC_REDIRECT_URI=http://localhost:3000/api/epic/callback
# Private RSA JWK from `node scripts/generate-epic-key.mjs` (one line of JSON)
EPIC_PRIVATE_JWK=
# During key rotation only: the previous public JWK, still served at /api/epic/jwks
EPIC_RETIRING_PUBLIC_JWK=
# 32 random bytes, base64: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
TOKEN_ENCRYPTION_KEY=
```

- [ ] **Step 7: Run all tests and commit**

```bash
npm test
git add src/lib/crypto src/lib/epic/errors.ts src/lib/env.ts src/lib/env.test.ts src/test/setup.ts .env.example
git commit -m "Add Epic environment settings and AES-GCM token sealing"
```

---

### Task 2: PKCE, state and the flow cookie

**Files:**
- Create: `src/lib/epic/pkce.ts`, `src/lib/epic/pkce.test.ts`, `src/lib/epic/flow.ts`, `src/lib/epic/flow.test.ts`

**Interfaces:**
- Consumes: `seal`, `unseal` (Task 1).
- Produces: `challengeFor(verifier: string): string`, `createPkcePair(): { verifier: string; challenge: string }`, `createState(): string`, `safeEqual(a: string, b: string): boolean`; `type Flow = { state; verifier; fhirBaseUrl; organizationName; tokenEndpoint; createdAt: number }`, `FLOW_COOKIE = "wh_epic_flow"`, `FLOW_TTL_SECONDS = 600`, `encodeFlow(flow, key): string`, `decodeFlow(value: string | undefined, key, now: Date): Flow | null`.

- [ ] **Step 1: Write the failing tests**

`src/lib/epic/pkce.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { challengeFor, createPkcePair, createState, safeEqual } from "./pkce";

describe("PKCE", () => {
  it("matches the RFC 7636 S256 test vector", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("creates a 43-character verifier and its challenge", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(challengeFor(verifier));
  });

  it("creates unpredictable state values", () => {
    const a = createState();
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).not.toBe(createState());
  });

  it("compares strings without short-circuiting on length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
```

`src/lib/epic/flow.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeFlow, encodeFlow, type Flow } from "./flow";

const key = randomBytes(32);
const flow: Flow = {
  state: "state-1",
  verifier: "verifier-1",
  fhirBaseUrl: "https://fhir.example.org/api/FHIR/R4",
  organizationName: "Example Health",
  tokenEndpoint: "https://fhir.example.org/oauth2/token",
  createdAt: Date.parse("2026-09-23T10:00:00Z"),
};

describe("flow cookie", () => {
  it("round-trips within ten minutes", () => {
    expect(decodeFlow(encodeFlow(flow, key), key, new Date("2026-09-23T10:09:59Z"))).toEqual(flow);
  });

  it("expires after ten minutes", () => {
    expect(decodeFlow(encodeFlow(flow, key), key, new Date("2026-09-23T10:10:01Z"))).toBeNull();
  });

  it("returns null for missing, tampered or foreign values", () => {
    const now = new Date("2026-09-23T10:01:00Z");
    expect(decodeFlow(undefined, key, now)).toBeNull();
    expect(decodeFlow("garbage", key, now)).toBeNull();
    expect(decodeFlow(encodeFlow(flow, randomBytes(32)), key, now)).toBeNull();
  });

  it("does not expose the verifier in the cookie value", () => {
    expect(encodeFlow(flow, key)).not.toContain("verifier-1");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/epic/pkce.test.ts src/lib/epic/flow.test.ts`
Expected: FAIL — cannot resolve `./pkce` and `./flow`.

- [ ] **Step 3: Implement `src/lib/epic/pkce.ts`**

```ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: challengeFor(verifier) };
}

export function createState(): string {
  return randomBytes(24).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}
```

- [ ] **Step 4: Implement `src/lib/epic/flow.ts`**

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass, then commit**

```bash
npx vitest run src/lib/epic/pkce.test.ts src/lib/epic/flow.test.ts
git add src/lib/epic/pkce.ts src/lib/epic/pkce.test.ts src/lib/epic/flow.ts src/lib/epic/flow.test.ts
git commit -m "Add PKCE, state and sealed flow cookie"
```

Expected: PASS, 8 tests.

---

### Task 3: Organization directory

**Files:**
- Create: `src/lib/epic/directory.ts`, `src/lib/epic/directory.test.ts`

**Interfaces:**
- Produces: `type Organization = { name: string; fhirBaseUrl: string }`, `EPIC_SANDBOX: Organization`, `EPIC_ENDPOINTS_URL`, `parseEndpoints(json: unknown): Organization[]`, `loadDirectory(environment: "sandbox" | "production", fetchImpl?: typeof fetch): Promise<Organization[]>`, `searchOrganizations(orgs, query, limit = 20): Organization[]`, `findOrganization(orgs, fhirBaseUrl): Organization | undefined`.

- [ ] **Step 1: Write the failing test `src/lib/epic/directory.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import {
  EPIC_ENDPOINTS_URL,
  EPIC_SANDBOX,
  findOrganization,
  loadDirectory,
  parseEndpoints,
  searchOrganizations,
} from "./directory";

const fixture = {
  Entries: [
    { OrganizationName: "Northwind Health", FHIRPatientFacingURI: "https://fhir.northwind.example/api/FHIR/R4/" },
    { OrganizationName: "Alder Valley Clinics", FHIRPatientFacingURI: "https://ehr.alder.example/FHIR/api/FHIR/R4" },
    { OrganizationName: "Northwind Health (duplicate)", FHIRPatientFacingURI: "https://fhir.northwind.example/api/FHIR/R4" },
    { OrganizationName: "Insecure Hospital", FHIRPatientFacingURI: "http://insecure.example/api/FHIR/R4" },
  ],
};

describe("parseEndpoints", () => {
  it("normalizes, de-duplicates, drops non-https and sorts by name", () => {
    expect(parseEndpoints(fixture)).toEqual([
      { name: "Alder Valley Clinics", fhirBaseUrl: "https://ehr.alder.example/FHIR/api/FHIR/R4" },
      { name: "Northwind Health", fhirBaseUrl: "https://fhir.northwind.example/api/FHIR/R4" },
    ]);
  });

  it("throws on an unexpected shape", () => {
    expect(() => parseEndpoints({ entries: [] })).toThrow();
  });
});

describe("searchOrganizations", () => {
  const orgs = parseEndpoints(fixture);

  it("matches every word, ignoring case", () => {
    expect(searchOrganizations(orgs, "north HEALTH").map((o) => o.name)).toEqual(["Northwind Health"]);
    expect(searchOrganizations(orgs, "valley north")).toEqual([]);
  });

  it("returns the first results for an empty query, up to the limit", () => {
    expect(searchOrganizations(orgs, "  ", 1)).toHaveLength(1);
  });
});

describe("findOrganization", () => {
  it("finds an allowed base URL with or without a trailing slash", () => {
    const orgs = parseEndpoints(fixture);
    expect(findOrganization(orgs, "https://fhir.northwind.example/api/FHIR/R4/")?.name).toBe("Northwind Health");
    expect(findOrganization(orgs, "https://evil.example/api/FHIR/R4")).toBeUndefined();
  });
});

describe("loadDirectory", () => {
  it("offers only the Epic sandbox in sandbox mode, without a network call", async () => {
    const fetchImpl = vi.fn();
    expect(await loadDirectory("sandbox", fetchImpl)).toEqual([EPIC_SANDBOX]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("loads Epic's published endpoints in production mode", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(fixture));
    const orgs = await loadDirectory("production", fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe(EPIC_ENDPOINTS_URL);
    expect(orgs).toHaveLength(2);
  });

  it("throws when the list is unavailable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("down", { status: 503 }));
    await expect(loadDirectory("production", fetchImpl)).rejects.toThrow(/503/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/epic/directory.test.ts`
Expected: FAIL — cannot resolve `./directory`.

- [ ] **Step 3: Implement `src/lib/epic/directory.ts`**

```ts
import { z } from "zod";

export type Organization = { name: string; fhirBaseUrl: string };

export const EPIC_SANDBOX: Organization = {
  name: "Epic sandbox (sample patients)",
  fhirBaseUrl: "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4",
};

// Epic's published list of patient-facing R4 endpoints (see open.epic.com → Endpoints).
export const EPIC_ENDPOINTS_URL = "https://open.epic.com/Endpoints/R4";

const endpointsSchema = z.object({
  Entries: z.array(
    z.object({
      OrganizationName: z.string().min(1),
      FHIRPatientFacingURI: z.string().min(1),
    }),
  ),
});

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function parseEndpoints(json: unknown): Organization[] {
  const seen = new Set<string>();
  const orgs: Organization[] = [];
  for (const entry of endpointsSchema.parse(json).Entries) {
    const fhirBaseUrl = normalize(entry.FHIRPatientFacingURI);
    if (!fhirBaseUrl.startsWith("https://") || seen.has(fhirBaseUrl)) continue;
    seen.add(fhirBaseUrl);
    orgs.push({ name: entry.OrganizationName.trim(), fhirBaseUrl });
  }
  return orgs.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadDirectory(
  environment: "sandbox" | "production",
  fetchImpl: typeof fetch = fetch,
): Promise<Organization[]> {
  if (environment === "sandbox") return [EPIC_SANDBOX];
  const response = await fetchImpl(EPIC_ENDPOINTS_URL, {
    headers: { Accept: "application/json" },
    next: { revalidate: 60 * 60 * 24 },
  });
  if (!response.ok) throw new Error(`Epic endpoint list responded ${response.status}`);
  return parseEndpoints(await response.json());
}

export function searchOrganizations(orgs: Organization[], query: string, limit = 20): Organization[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return orgs.filter((org) => words.every((word) => org.name.toLowerCase().includes(word))).slice(0, limit);
}

export function findOrganization(orgs: Organization[], fhirBaseUrl: string): Organization | undefined {
  const wanted = normalize(fhirBaseUrl);
  return orgs.find((org) => org.fhirBaseUrl === wanted);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/epic/directory.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Check the live endpoint list shape (production readiness)**

```bash
curl -s -H "Accept: application/json" https://open.epic.com/Endpoints/R4 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(Object.keys(j), j.Entries?.[0])})"
```

Expected: keys include `Entries`, and the first entry has `OrganizationName` and `FHIRPatientFacingURI`. If Epic has changed the URL or shape (check open.epic.com → Endpoints), update `EPIC_ENDPOINTS_URL`, `endpointsSchema` and the test fixture together. This list is only used when `EPIC_ENVIRONMENT=production`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/epic/directory.ts src/lib/epic/directory.test.ts
git commit -m "Add Epic organization directory with sandbox mode"
```

---

### Task 4: SMART configuration discovery

**Files:**
- Create: `src/lib/epic/smart.ts`, `src/lib/epic/smart.test.ts`

**Interfaces:**
- Consumes: `EpicError` (Task 1).
- Produces: `type SmartConfiguration = { authorizationEndpoint: string; tokenEndpoint: string }`, `discoverSmartConfiguration(fhirBaseUrl: string, fetchImpl?: typeof fetch): Promise<SmartConfiguration>`.

- [ ] **Step 1: Write the failing test `src/lib/epic/smart.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { EpicError } from "./errors";
import { discoverSmartConfiguration } from "./smart";

const config = {
  authorization_endpoint: "https://fhir.example.org/oauth2/authorize",
  token_endpoint: "https://fhir.example.org/oauth2/token",
  code_challenge_methods_supported: ["S256"],
};

describe("discoverSmartConfiguration", () => {
  it("reads the endpoints from .well-known/smart-configuration", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(config));
    const result = await discoverSmartConfiguration("https://fhir.example.org/api/FHIR/R4/", fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://fhir.example.org/api/FHIR/R4/.well-known/smart-configuration");
    expect(result).toEqual({
      authorizationEndpoint: config.authorization_endpoint,
      tokenEndpoint: config.token_endpoint,
    });
  });

  it("rejects non-https endpoints", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ ...config, token_endpoint: "http://fhir.example.org/token" }));
    await expect(discoverSmartConfiguration("https://fhir.example.org/R4", fetchImpl)).rejects.toThrow(EpicError);
  });

  it("rejects servers that do not support S256", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ ...config, code_challenge_methods_supported: ["plain"] }));
    await expect(discoverSmartConfiguration("https://fhir.example.org/R4", fetchImpl)).rejects.toThrow(/pkce_unsupported/);
  });

  it("reports HTTP failures with the discovery stage", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
    await expect(discoverSmartConfiguration("https://fhir.example.org/R4", fetchImpl)).rejects.toMatchObject({
      stage: "discovery",
      status: 404,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/epic/smart.test.ts`
Expected: FAIL — cannot resolve `./smart`.

- [ ] **Step 3: Implement `src/lib/epic/smart.ts`**

```ts
import { z } from "zod";
import { EpicError } from "./errors";

const smartSchema = z.object({
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});

export type SmartConfiguration = { authorizationEndpoint: string; tokenEndpoint: string };

export async function discoverSmartConfiguration(
  fhirBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SmartConfiguration> {
  const url = `${fhirBaseUrl.replace(/\/+$/, "")}/.well-known/smart-configuration`;
  const response = await fetchImpl(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new EpicError("discovery", response.status);

  const parsed = smartSchema.safeParse(await response.json());
  if (!parsed.success) throw new EpicError("discovery", undefined, "invalid_configuration");
  const { authorization_endpoint, token_endpoint, code_challenge_methods_supported } = parsed.data;

  if (!authorization_endpoint.startsWith("https://") || !token_endpoint.startsWith("https://")) {
    throw new EpicError("discovery", undefined, "insecure_endpoint");
  }
  if (code_challenge_methods_supported && !code_challenge_methods_supported.includes("S256")) {
    throw new EpicError("discovery", undefined, "pkce_unsupported");
  }
  return { authorizationEndpoint: authorization_endpoint, tokenEndpoint: token_endpoint };
}
```

- [ ] **Step 4: Run the tests, then commit**

```bash
npx vitest run src/lib/epic/smart.test.ts
git add src/lib/epic/smart.ts src/lib/epic/smart.test.ts
git commit -m "Add SMART configuration discovery"
```

Expected: PASS, 4 tests.

---

### Task 5: JWT client authentication and the JWKS route

**Files:**
- Create: `src/lib/epic/client-assertion.ts`, `src/lib/epic/client-assertion.test.ts`, `scripts/generate-epic-key.mjs`, `src/app/api/epic/jwks/route.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `CLIENT_ASSERTION_TYPE`, `type PrivateJwk = JWK & { kid: string }`, `parsePrivateJwk(json: string): PrivateJwk`, `createClientAssertion({ clientId, tokenEndpoint, privateJwk, now? }): Promise<string>`, `publicJwks(current: JWK, retiring?: JWK): { keys: JWK[] }`.

- [ ] **Step 1: Install `jose`**

```bash
npm install jose
```

- [ ] **Step 2: Write the failing test `src/lib/epic/client-assertion.test.ts`**

```ts
import { createLocalJWKSet, decodeProtectedHeader, exportJWK, generateKeyPair, jwtVerify } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createClientAssertion, parsePrivateJwk, publicJwks, type PrivateJwk } from "./client-assertion";

let privateJwk: PrivateJwk;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS384", { modulusLength: 2048, extractable: true });
  privateJwk = { ...(await exportJWK(privateKey)), kid: "key-1" };
});

describe("createClientAssertion", () => {
  it("signs an RS384 JWT Epic can verify with our public JWKS", async () => {
    const tokenEndpoint = "https://fhir.example.org/oauth2/token";
    const now = new Date();
    const jwt = await createClientAssertion({ clientId: "client-123", tokenEndpoint, privateJwk, now });

    expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: "RS384", kid: "key-1", typ: "JWT" });
    const { payload } = await jwtVerify(jwt, createLocalJWKSet(publicJwks(privateJwk)), {
      issuer: "client-123",
      audience: tokenEndpoint,
      currentDate: now,
    });
    expect(payload.sub).toBe("client-123");
    expect(payload.jti).toEqual(expect.any(String));
    expect(payload.exp! - payload.iat!).toBe(240);
  });

  it("uses a new jti every time", async () => {
    const args = { clientId: "c", tokenEndpoint: "https://x.example/token", privateJwk };
    const a = await createClientAssertion(args);
    const b = await createClientAssertion(args);
    expect(decodeJwtId(a)).not.toBe(decodeJwtId(b));
  });
});

describe("publicJwks", () => {
  it("publishes only public parts, plus the retiring key when rotating", () => {
    const jwks = publicJwks(privateJwk, { kty: "RSA", n: "old-n", e: "AQAB", kid: "key-0" });
    expect(jwks.keys.map((k) => k.kid)).toEqual(["key-1", "key-0"]);
    expect(jwks.keys[0]).not.toHaveProperty("d");
    expect(jwks.keys[0]).toMatchObject({ alg: "RS384", use: "sig" });
  });
});

describe("parsePrivateJwk", () => {
  it("requires a private RSA key with a kid", () => {
    expect(parsePrivateJwk(JSON.stringify(privateJwk)).kid).toBe("key-1");
    expect(() => parsePrivateJwk('{"kty":"RSA","n":"x","e":"AQAB","kid":"k"}')).toThrow(/private RSA JWK/);
  });
});

function decodeJwtId(jwt: string): string {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).jti;
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/lib/epic/client-assertion.test.ts`
Expected: FAIL — cannot resolve `./client-assertion`.

- [ ] **Step 4: Implement `src/lib/epic/client-assertion.ts`**

```ts
import { randomUUID } from "node:crypto";
import { importJWK, SignJWT, type JWK } from "jose";

export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const ALG = "RS384";
const LIFETIME_SECONDS = 240;

export type PrivateJwk = JWK & { kid: string };

export function parsePrivateJwk(json: string): PrivateJwk {
  const jwk = JSON.parse(json) as JWK;
  if (jwk.kty !== "RSA" || !jwk.d || !jwk.kid) {
    throw new Error("EPIC_PRIVATE_JWK must be a private RSA JWK with a kid");
  }
  return jwk as PrivateJwk;
}

export async function createClientAssertion({
  clientId,
  tokenEndpoint,
  privateJwk,
  now = new Date(),
}: {
  clientId: string;
  tokenEndpoint: string;
  privateJwk: PrivateJwk;
  now?: Date;
}): Promise<string> {
  const key = await importJWK(privateJwk, ALG);
  const issuedAt = Math.floor(now.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG, kid: privateJwk.kid, typ: "JWT" })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(tokenEndpoint)
    .setJti(randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + LIFETIME_SECONDS)
    .sign(key);
}

function toPublic({ kty, n, e, kid }: JWK): JWK {
  return { kty, n, e, kid, alg: ALG, use: "sig" };
}

export function publicJwks(current: JWK, retiring?: JWK): { keys: JWK[] } {
  return { keys: retiring ? [toPublic(current), toPublic(retiring)] : [toPublic(current)] };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/epic/client-assertion.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Add the key generator and JWKS route**

`scripts/generate-epic-key.mjs`:

```js
// Prints a new private RSA JWK for EPIC_PRIVATE_JWK. Store it only in Vercel env
// settings or .env.local, never in git.
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";

const { privateKey } = await generateKeyPair("RS384", { modulusLength: 2048, extractable: true });
const jwk = { ...(await exportJWK(privateKey)), kid: randomUUID(), alg: "RS384", use: "sig" };
console.log(JSON.stringify(jwk));
```

Add to `"scripts"` in `package.json`:

```json
"epic:key": "node scripts/generate-epic-key.mjs"
```

`src/app/api/epic/jwks/route.ts`:

```ts
import type { JWK } from "jose";
import { parsePrivateJwk, publicJwks } from "@/lib/epic/client-assertion";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export function GET() {
  const { EPIC_PRIVATE_JWK, EPIC_RETIRING_PUBLIC_JWK } = env();
  const retiring = EPIC_RETIRING_PUBLIC_JWK ? (JSON.parse(EPIC_RETIRING_PUBLIC_JWK) as JWK) : undefined;
  return Response.json(publicJwks(parsePrivateJwk(EPIC_PRIVATE_JWK), retiring), {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
```

- [ ] **Step 7: Generate keys and check the route**

```bash
npm run epic:key
```

Put the printed JSON on one line as `EPIC_PRIVATE_JWK=` in `.env.local`, and in Vercel Development and Preview (use the **same** key for both, so local development signs with the key Epic fetches from Preview). Generate `TOKEN_ENCRYPTION_KEY` with the command in `.env.example` and add it the same way. Then with `npm run dev`:

```bash
curl -s http://localhost:3000/api/epic/jwks
```

Expected: `{"keys":[{"kty":"RSA","n":"…","e":"AQAB","kid":"…","alg":"RS384","use":"sig"}]}` with no `"d"` field.

- [ ] **Step 8: Commit**

```bash
npm run lint
git add src/lib/epic/client-assertion.ts src/lib/epic/client-assertion.test.ts scripts/generate-epic-key.mjs src/app/api/epic/jwks package.json package-lock.json
git commit -m "Add JWT client assertion and public JWKS route"
```

---

### Task 6: Scopes, authorize URL and the authorize route

**Files:**
- Create: `src/lib/epic/authorize.ts`, `src/lib/epic/authorize.test.ts`, `src/lib/epic/server.ts`, `src/app/api/epic/authorize/route.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: `EPIC_SCOPES: readonly string[]`, `SCOPE_LABELS: { scope: string; label: string }[]`, `buildAuthorizeUrl(input): string`; in `src/lib/epic/server.ts` (server-only): `tokenKey(): Buffer`, `epicPrivateJwk(): PrivateJwk`, `clientAssertionFor(tokenEndpoint: string): Promise<string>`.

- [ ] **Step 1: Write the failing test `src/lib/epic/authorize.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { buildAuthorizeUrl, EPIC_SCOPES, SCOPE_LABELS } from "./authorize";

describe("buildAuthorizeUrl", () => {
  it("builds a SMART standalone launch request with PKCE and aud", () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: "https://fhir.example.org/oauth2/authorize",
        clientId: "client-123",
        redirectUri: "http://localhost:3000/api/epic/callback",
        state: "state-1",
        codeChallenge: "challenge-1",
        aud: "https://fhir.example.org/api/FHIR/R4",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://fhir.example.org/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-123",
      redirect_uri: "http://localhost:3000/api/epic/callback",
      scope: EPIC_SCOPES.join(" "),
      state: "state-1",
      aud: "https://fhir.example.org/api/FHIR/R4",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
    });
  });

  it("requests patient launch, refresh and only read scopes", () => {
    expect(EPIC_SCOPES).toContain("launch/patient");
    expect(EPIC_SCOPES).toContain("offline_access");
    const resourceScopes = EPIC_SCOPES.filter((s) => s.startsWith("patient/"));
    expect(resourceScopes.every((s) => s.endsWith(".read"))).toBe(true);
  });

  it("has a plain-language label for every resource scope", () => {
    const labelled = SCOPE_LABELS.map((item) => item.scope);
    for (const scope of EPIC_SCOPES.filter((s) => s.startsWith("patient/"))) expect(labelled).toContain(scope);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/epic/authorize.test.ts`
Expected: FAIL — cannot resolve `./authorize`.

- [ ] **Step 3: Implement `src/lib/epic/authorize.ts`**

```ts
export const EPIC_SCOPES = [
  "openid",
  "fhirUser",
  "launch/patient",
  "offline_access",
  "patient/Patient.read",
  "patient/Condition.read",
  "patient/MedicationRequest.read",
  "patient/AllergyIntolerance.read",
  "patient/Observation.read",
  "patient/Immunization.read",
  "patient/Encounter.read",
] as const;

// Shown on the connections page: "what we ask for", in plain language.
export const SCOPE_LABELS: { scope: string; label: string }[] = [
  { scope: "patient/Patient.read", label: "Your name and date of birth, to match your record" },
  { scope: "patient/Condition.read", label: "Conditions on your problem list" },
  { scope: "patient/MedicationRequest.read", label: "Medications you've been prescribed" },
  { scope: "patient/AllergyIntolerance.read", label: "Allergies" },
  { scope: "patient/Observation.read", label: "Lab results" },
  { scope: "patient/Immunization.read", label: "Immunizations" },
  { scope: "patient/Encounter.read", label: "Visits" },
  { scope: "offline_access", label: "Staying connected, so you don't sign in to MyChart every time" },
];

export function buildAuthorizeUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  aud: string;
  scopes?: readonly string[];
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: (input.scopes ?? EPIC_SCOPES).join(" "),
    state: input.state,
    aud: input.aud,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/epic/authorize.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Create the server-only wiring `src/lib/epic/server.ts`**

```ts
import "server-only";
import { keyFromBase64 } from "@/lib/crypto/seal";
import { env } from "@/lib/env";
import { createClientAssertion, parsePrivateJwk, type PrivateJwk } from "./client-assertion";

export function tokenKey(): Buffer {
  return keyFromBase64(env().TOKEN_ENCRYPTION_KEY);
}

export function epicPrivateJwk(): PrivateJwk {
  return parsePrivateJwk(env().EPIC_PRIVATE_JWK);
}

export function clientAssertionFor(tokenEndpoint: string): Promise<string> {
  return createClientAssertion({ clientId: env().EPIC_CLIENT_ID, tokenEndpoint, privateJwk: epicPrivateJwk() });
}
```

- [ ] **Step 6: Create the authorize route `src/app/api/epic/authorize/route.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { buildAuthorizeUrl } from "@/lib/epic/authorize";
import { findOrganization, loadDirectory } from "@/lib/epic/directory";
import { encodeFlow, FLOW_COOKIE, FLOW_TTL_SECONDS } from "@/lib/epic/flow";
import { createPkcePair, createState } from "@/lib/epic/pkce";
import { tokenKey } from "@/lib/epic/server";
import { discoverSmartConfiguration } from "@/lib/epic/smart";
import { env } from "@/lib/env";

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.redirect(new URL("/sign-in", request.url));

  const { EPIC_ENVIRONMENT, EPIC_CLIENT_ID, EPIC_REDIRECT_URI } = env();
  const iss = request.nextUrl.searchParams.get("iss") ?? "";
  const organization = findOrganization(await loadDirectory(EPIC_ENVIRONMENT), iss);
  if (!organization) return NextResponse.json({ error: "unknown_organization" }, { status: 400 });

  let smart;
  try {
    smart = await discoverSmartConfiguration(organization.fhirBaseUrl);
  } catch (error) {
    console.error("[epic] discovery failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.redirect(new URL("/app/connections?error=unavailable", request.url));
  }

  const { verifier, challenge } = createPkcePair();
  const state = createState();
  const response = NextResponse.redirect(
    buildAuthorizeUrl({
      authorizationEndpoint: smart.authorizationEndpoint,
      clientId: EPIC_CLIENT_ID,
      redirectUri: EPIC_REDIRECT_URI,
      state,
      codeChallenge: challenge,
      aud: organization.fhirBaseUrl,
    }),
  );
  response.cookies.set(
    FLOW_COOKIE,
    encodeFlow(
      {
        state,
        verifier,
        fhirBaseUrl: organization.fhirBaseUrl,
        organizationName: organization.name,
        tokenEndpoint: smart.tokenEndpoint,
        createdAt: Date.now(),
      },
      tokenKey(),
    ),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/epic",
      maxAge: FLOW_TTL_SECONDS,
    },
  );
  return response;
}
```

- [ ] **Step 7: Check the route by hand**

With `npm run dev`, signed in:
1. `curl -si "http://localhost:3000/api/epic/authorize?iss=https://evil.example/R4" -H "cookie: <your session cookie>"` returns `400 {"error":"unknown_organization"}`.
2. In the browser, open `/api/epic/authorize?iss=https%3A%2F%2Ffhir.epic.com%2Finterconnect-fhir-oauth%2Fapi%2FFHIR%2FR4`. You land on Epic's sandbox MyChart login, and DevTools shows a `wh_epic_flow` cookie on path `/api/epic`, marked HttpOnly.

- [ ] **Step 8: Commit**

```bash
npm run lint
git add src/lib/epic/authorize.ts src/lib/epic/authorize.test.ts src/lib/epic/server.ts src/app/api/epic/authorize
git commit -m "Add SMART authorize route with allowlisted organizations"
```

---

### Task 7: Token exchange, encrypted connections and the callback

**Files:**
- Create: `src/lib/epic/tokens.ts`, `src/lib/epic/tokens.test.ts`, `src/lib/db/epic-schema.ts`, `src/lib/epic/connections.ts`, `src/lib/epic/connections.test.ts`, `src/lib/epic/callback.ts`, `src/lib/epic/callback.test.ts`, `src/app/api/epic/callback/route.ts`
- Modify: `src/lib/db/schema.ts`
- Generated: `drizzle/0002_*.sql`

**Interfaces:**
- Consumes: Tasks 1–6; `getProfile`, `completeOnboarding`, `onboardingStep` (plan 02).
- Produces:
  - `type TokenSet = { accessToken: string; refreshToken?: string; expiresAt: Date; scope: string; patientId?: string }`, `type InitialTokenSet = TokenSet & { patientId: string }`
  - `exchangeCode(input): Promise<InitialTokenSet>`, `refreshAccessToken(input): Promise<TokenSet>`
  - `epicConnection` table
  - `type ConnectionSummary = { id; organizationName; fhirBaseUrl; scope; connectedAt: Date }`, `type ConnectionSecrets = ConnectionSummary & { tokenEndpoint; patientId; accessToken; refreshToken: string | null; accessTokenExpiresAt: Date }`
  - `saveConnection(db, key, input, now)`, `listConnections(db, userId)`, `getConnectionSecrets(db, key, userId)`, `updateTokens(db, key, id, tokens, now)`, `deleteConnection(db, userId, id): Promise<boolean>`
  - `type CallbackFailure = "denied" | "expired" | "invalid_state" | "token_failed"`, `completeAuthorization(deps): Promise<{ ok: true } | { ok: false; reason: CallbackFailure }>`

- [ ] **Step 1: Write the failing token tests `src/lib/epic/tokens.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { CLIENT_ASSERTION_TYPE } from "./client-assertion";
import { EpicError, ReconnectRequiredError } from "./errors";
import { exchangeCode, refreshAccessToken } from "./tokens";

const now = new Date("2026-09-23T10:00:00Z");
const tokenEndpoint = "https://fhir.example.org/oauth2/token";

function bodyOf(fetchImpl: ReturnType<typeof vi.fn>) {
  return Object.fromEntries(new URLSearchParams(fetchImpl.mock.calls[0][1].body));
}

describe("exchangeCode", () => {
  it("posts the code, verifier and JWT assertion and returns the token set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        access_token: "at-1",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "launch/patient patient/Condition.read",
        refresh_token: "rt-1",
        patient: "pat-1",
      }),
    );
    const tokens = await exchangeCode({
      tokenEndpoint,
      code: "code-1",
      codeVerifier: "verifier-1",
      redirectUri: "http://localhost:3000/api/epic/callback",
      clientId: "client-123",
      clientAssertion: "signed.jwt.value",
      fetchImpl,
      now,
    });

    expect(fetchImpl.mock.calls[0][0]).toBe(tokenEndpoint);
    expect(bodyOf(fetchImpl)).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "http://localhost:3000/api/epic/callback",
      code_verifier: "verifier-1",
      client_id: "client-123",
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: "signed.jwt.value",
    });
    expect(tokens).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: new Date("2026-09-23T11:00:00Z"),
      scope: "launch/patient patient/Condition.read",
      patientId: "pat-1",
    });
  });

  it("fails when Epic does not return a patient", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({ access_token: "at", token_type: "Bearer", expires_in: 60, scope: "openid" }),
    );
    await expect(
      exchangeCode({ tokenEndpoint, code: "c", codeVerifier: "v", redirectUri: "http://x/cb", clientId: "c", clientAssertion: "j", fetchImpl, now }),
    ).rejects.toMatchObject({ stage: "token", code: "missing_patient" });
  });

  it("reports the OAuth error code without the response body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ error: "invalid_client" }, { status: 401 }));
    const promise = exchangeCode({ tokenEndpoint, code: "c", codeVerifier: "v", redirectUri: "http://x/cb", clientId: "c", clientAssertion: "j", fetchImpl, now });
    await expect(promise).rejects.toBeInstanceOf(EpicError);
    await expect(promise).rejects.toMatchObject({ status: 401, code: "invalid_client" });
  });
});

describe("refreshAccessToken", () => {
  it("posts a refresh grant and keeps going without a new refresh token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({ access_token: "at-2", token_type: "bearer", expires_in: 1800, scope: "patient/Condition.read" }),
    );
    const tokens = await refreshAccessToken({ tokenEndpoint, refreshToken: "rt-1", clientId: "client-123", clientAssertion: "j", fetchImpl, now });
    expect(bodyOf(fetchImpl)).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt-1", client_assertion: "j" });
    expect(tokens).toEqual({
      accessToken: "at-2",
      refreshToken: undefined,
      expiresAt: new Date("2026-09-23T10:30:00Z"),
      scope: "patient/Condition.read",
      patientId: undefined,
    });
  });

  it("asks for a reconnect when the refresh token is no longer valid", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ error: "invalid_grant" }, { status: 400 }));
    await expect(
      refreshAccessToken({ tokenEndpoint, refreshToken: "rt", clientId: "c", clientAssertion: "j", fetchImpl, now }),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/epic/tokens.test.ts`
Expected: FAIL — cannot resolve `./tokens`.

- [ ] **Step 3: Implement `src/lib/epic/tokens.ts`**

```ts
import { z } from "zod";
import { CLIENT_ASSERTION_TYPE } from "./client-assertion";
import { EpicError, ReconnectRequiredError, type EpicStage } from "./errors";

const tokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z.number().int().positive(),
  scope: z.string(),
  refresh_token: z.string().min(1).optional(),
  patient: z.string().min(1).optional(),
});

export type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scope: string;
  patientId?: string;
};

export type InitialTokenSet = TokenSet & { patientId: string };

type Common = { tokenEndpoint: string; clientId: string; clientAssertion: string; fetchImpl?: typeof fetch; now?: Date };

async function postToken(
  stage: Extract<EpicStage, "token" | "refresh">,
  { tokenEndpoint, clientId, clientAssertion, fetchImpl = fetch, now = new Date() }: Common,
  grant: Record<string, string>,
): Promise<TokenSet> {
  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      ...grant,
      client_id: clientId,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: clientAssertion,
    }),
    cache: "no-store",
  });

  const json: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof json === "object" && json && "error" in json ? String(json.error) : undefined;
    if (stage === "refresh" && code === "invalid_grant") throw new ReconnectRequiredError();
    throw new EpicError(stage, response.status, code);
  }

  const parsed = tokenResponse.safeParse(json);
  if (!parsed.success) throw new EpicError(stage, response.status, "invalid_token_response");
  const data = parsed.data;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(now.getTime() + data.expires_in * 1000),
    scope: data.scope,
    patientId: data.patient,
  };
}

export async function exchangeCode(
  input: Common & { code: string; codeVerifier: string; redirectUri: string },
): Promise<InitialTokenSet> {
  const tokens = await postToken("token", input, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  if (!tokens.patientId) throw new EpicError("token", undefined, "missing_patient");
  return { ...tokens, patientId: tokens.patientId };
}

export function refreshAccessToken(input: Common & { refreshToken: string }): Promise<TokenSet> {
  return postToken("refresh", input, { grant_type: "refresh_token", refresh_token: input.refreshToken });
}
```

- [ ] **Step 4: Run the token tests to verify they pass**

Run: `npx vitest run src/lib/epic/tokens.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add the table**

`src/lib/db/epic-schema.ts`:

```ts
import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const epicConnection = pgTable(
  "epic_connection",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    fhirBaseUrl: text("fhir_base_url").notNull(),
    organizationName: text("organization_name").notNull(),
    tokenEndpoint: text("token_endpoint").notNull(),
    // Sealed with TOKEN_ENCRYPTION_KEY (src/lib/crypto/seal.ts). Never store these in plaintext.
    sealedPatientId: text("sealed_patient_id").notNull(),
    sealedAccessToken: text("sealed_access_token").notNull(),
    sealedRefreshToken: text("sealed_refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }).notNull(),
    scope: text("scope").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("epic_connection_user_org_idx").on(table.userId, table.fhirBaseUrl)],
);
```

Replace `src/lib/db/schema.ts` with:

```ts
export * from "./auth-schema";
export * from "./epic-schema";
export * from "./profile-schema";
```

- [ ] **Step 6: Write the failing repository tests `src/lib/epic/connections.test.ts`**

```ts
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { epicConnection } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { createTestDb, createTestUser } from "@/test/db";
import { deleteConnection, getConnectionSecrets, listConnections, saveConnection, updateTokens } from "./connections";

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
});
```

- [ ] **Step 7: Run them to verify they fail**

Run: `npx vitest run src/lib/epic/connections.test.ts`
Expected: FAIL — cannot resolve `./connections`.

- [ ] **Step 8: Implement `src/lib/epic/connections.ts`**

```ts
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { seal, unseal } from "@/lib/crypto/seal";
import { epicConnection } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { InitialTokenSet, TokenSet } from "./tokens";

export type ConnectionSummary = {
  id: string;
  organizationName: string;
  fhirBaseUrl: string;
  scope: string;
  connectedAt: Date;
};

export type ConnectionSecrets = ConnectionSummary & {
  tokenEndpoint: string;
  patientId: string;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date;
};

export async function saveConnection(
  db: Db,
  key: Buffer,
  input: { userId: string; fhirBaseUrl: string; organizationName: string; tokenEndpoint: string; tokens: InitialTokenSet },
  now: Date,
): Promise<void> {
  const secrets = {
    organizationName: input.organizationName,
    tokenEndpoint: input.tokenEndpoint,
    sealedPatientId: seal(input.tokens.patientId, key),
    sealedAccessToken: seal(input.tokens.accessToken, key),
    sealedRefreshToken: input.tokens.refreshToken ? seal(input.tokens.refreshToken, key) : null,
    accessTokenExpiresAt: input.tokens.expiresAt,
    scope: input.tokens.scope,
    updatedAt: now,
  };
  await db
    .insert(epicConnection)
    .values({ id: randomUUID(), userId: input.userId, fhirBaseUrl: input.fhirBaseUrl, createdAt: now, ...secrets })
    .onConflictDoUpdate({ target: [epicConnection.userId, epicConnection.fhirBaseUrl], set: secrets });
}

export async function listConnections(db: Db, userId: string): Promise<ConnectionSummary[]> {
  const rows = await db
    .select({
      id: epicConnection.id,
      organizationName: epicConnection.organizationName,
      fhirBaseUrl: epicConnection.fhirBaseUrl,
      scope: epicConnection.scope,
      connectedAt: epicConnection.createdAt,
    })
    .from(epicConnection)
    .where(eq(epicConnection.userId, userId))
    .orderBy(asc(epicConnection.createdAt));
  return rows;
}

export async function getConnectionSecrets(db: Db, key: Buffer, userId: string): Promise<ConnectionSecrets[]> {
  const rows = await db.select().from(epicConnection).where(eq(epicConnection.userId, userId)).orderBy(asc(epicConnection.createdAt));
  return rows.map((row) => ({
    id: row.id,
    organizationName: row.organizationName,
    fhirBaseUrl: row.fhirBaseUrl,
    scope: row.scope,
    connectedAt: row.createdAt,
    tokenEndpoint: row.tokenEndpoint,
    patientId: unseal(row.sealedPatientId, key),
    accessToken: unseal(row.sealedAccessToken, key),
    refreshToken: row.sealedRefreshToken ? unseal(row.sealedRefreshToken, key) : null,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
  }));
}

export async function updateTokens(db: Db, key: Buffer, id: string, tokens: TokenSet, now: Date): Promise<void> {
  await db
    .update(epicConnection)
    .set({
      sealedAccessToken: seal(tokens.accessToken, key),
      ...(tokens.refreshToken ? { sealedRefreshToken: seal(tokens.refreshToken, key) } : {}),
      accessTokenExpiresAt: tokens.expiresAt,
      scope: tokens.scope,
      updatedAt: now,
    })
    .where(eq(epicConnection.id, id));
}

export async function deleteConnection(db: Db, userId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(epicConnection)
    .where(and(eq(epicConnection.id, id), eq(epicConnection.userId, userId)))
    .returning({ id: epicConnection.id });
  return deleted.length > 0;
}
```

- [ ] **Step 9: Generate the migration and run the repository tests**

```bash
npm run db:generate
npx vitest run src/lib/epic/connections.test.ts
```

Expected: `drizzle/0002_*.sql` creates `epic_connection` with the unique index; PASS, 6 tests.

- [ ] **Step 10: Write the failing callback tests `src/lib/epic/callback.test.ts`**

```ts
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { completeAuthorization } from "./callback";
import { encodeFlow, type Flow } from "./flow";

const key = randomBytes(32);
const now = new Date("2026-09-23T10:01:00Z");
const flow: Flow = {
  state: "state-1",
  verifier: "verifier-1",
  fhirBaseUrl: "https://fhir.example.org/api/FHIR/R4",
  organizationName: "Example Health",
  tokenEndpoint: "https://fhir.example.org/oauth2/token",
  createdAt: Date.parse("2026-09-23T10:00:00Z"),
};
const tokens = { accessToken: "at", refreshToken: "rt", expiresAt: now, scope: "s", patientId: "p" };

function deps(overrides: Partial<Parameters<typeof completeAuthorization>[0]> = {}) {
  return {
    params: { code: "code-1", state: "state-1", error: null },
    flowCookie: encodeFlow(flow, key),
    key,
    now,
    exchange: vi.fn().mockResolvedValue(tokens),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("completeAuthorization", () => {
  it("exchanges the code with the stored verifier and saves the connection", async () => {
    const d = deps();
    expect(await completeAuthorization(d)).toEqual({ ok: true });
    expect(d.exchange).toHaveBeenCalledWith({ tokenEndpoint: flow.tokenEndpoint, code: "code-1", codeVerifier: "verifier-1" });
    expect(d.save).toHaveBeenCalledWith(flow, tokens);
  });

  it("reports a denial from MyChart without exchanging anything", async () => {
    const d = deps({ params: { code: null, state: "state-1", error: "access_denied" } });
    expect(await completeAuthorization(d)).toEqual({ ok: false, reason: "denied" });
    expect(d.exchange).not.toHaveBeenCalled();
  });

  it("rejects a missing or expired flow cookie", async () => {
    expect(await completeAuthorization(deps({ flowCookie: undefined }))).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a state mismatch", async () => {
    const d = deps({ params: { code: "code-1", state: "someone-else", error: null } });
    expect(await completeAuthorization(d)).toEqual({ ok: false, reason: "invalid_state" });
    expect(d.exchange).not.toHaveBeenCalled();
  });

  it("reports token failures without saving", async () => {
    const d = deps({ exchange: vi.fn().mockRejectedValue(new Error("boom")) });
    expect(await completeAuthorization(d)).toEqual({ ok: false, reason: "token_failed" });
    expect(d.save).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 11: Run them to verify they fail**

Run: `npx vitest run src/lib/epic/callback.test.ts`
Expected: FAIL — cannot resolve `./callback`.

- [ ] **Step 12: Implement `src/lib/epic/callback.ts`**

```ts
import { decodeFlow, type Flow } from "./flow";
import { safeEqual } from "./pkce";
import type { InitialTokenSet } from "./tokens";

export type CallbackFailure = "denied" | "expired" | "invalid_state" | "token_failed";

export async function completeAuthorization(deps: {
  params: { code: string | null; state: string | null; error: string | null };
  flowCookie: string | undefined;
  key: Buffer;
  now: Date;
  exchange: (input: { tokenEndpoint: string; code: string; codeVerifier: string }) => Promise<InitialTokenSet>;
  save: (flow: Flow, tokens: InitialTokenSet) => Promise<void>;
}): Promise<{ ok: true } | { ok: false; reason: CallbackFailure }> {
  const { params } = deps;
  if (params.error) return { ok: false, reason: "denied" };

  const flow = decodeFlow(deps.flowCookie, deps.key, deps.now);
  if (!flow) return { ok: false, reason: "expired" };
  if (!params.code || !params.state || !safeEqual(params.state, flow.state)) {
    return { ok: false, reason: "invalid_state" };
  }

  let tokens: InitialTokenSet;
  try {
    tokens = await deps.exchange({ tokenEndpoint: flow.tokenEndpoint, code: params.code, codeVerifier: flow.verifier });
  } catch (error) {
    console.error("[epic] token exchange failed", error instanceof Error ? error.message : "unknown");
    return { ok: false, reason: "token_failed" };
  }

  await deps.save(flow, tokens);
  return { ok: true };
}
```

- [ ] **Step 13: Run the callback tests to verify they pass**

Run: `npx vitest run src/lib/epic/callback.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 14: Create the callback route `src/app/api/epic/callback/route.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { completeAuthorization } from "@/lib/epic/callback";
import { saveConnection } from "@/lib/epic/connections";
import { FLOW_COOKIE } from "@/lib/epic/flow";
import { clientAssertionFor, tokenKey } from "@/lib/epic/server";
import { exchangeCode } from "@/lib/epic/tokens";
import { env } from "@/lib/env";
import { onboardingStep } from "@/lib/onboarding";
import { completeOnboarding, getProfile } from "@/lib/profile";

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.redirect(new URL("/sign-in", request.url));

  const userId = session.user.id;
  const key = tokenKey();
  const { EPIC_CLIENT_ID, EPIC_REDIRECT_URI } = env();
  const params = request.nextUrl.searchParams;
  const inOnboarding = onboardingStep(await getProfile(db, userId)) === "connect";

  const result = await completeAuthorization({
    params: { code: params.get("code"), state: params.get("state"), error: params.get("error") },
    flowCookie: request.cookies.get(FLOW_COOKIE)?.value,
    key,
    now: new Date(),
    exchange: async ({ tokenEndpoint, code, codeVerifier }) =>
      exchangeCode({
        tokenEndpoint,
        code,
        codeVerifier,
        redirectUri: EPIC_REDIRECT_URI,
        clientId: EPIC_CLIENT_ID,
        clientAssertion: await clientAssertionFor(tokenEndpoint),
      }),
    save: (flow, tokens) =>
      saveConnection(
        db,
        key,
        {
          userId,
          fhirBaseUrl: flow.fhirBaseUrl,
          organizationName: flow.organizationName,
          tokenEndpoint: flow.tokenEndpoint,
          tokens,
        },
        new Date(),
      ),
  });

  let target: string;
  if (result.ok && inOnboarding) {
    await completeOnboarding(db, userId, new Date());
    target = "/app";
  } else if (result.ok) {
    target = "/app/connections?connected=1";
  } else {
    target = `${inOnboarding ? "/app/onboarding" : "/app/connections"}?error=${result.reason}`;
  }

  const response = NextResponse.redirect(new URL(target, request.url));
  response.cookies.delete({ name: FLOW_COOKIE, path: "/api/epic" });
  return response;
}
```

- [ ] **Step 15: Apply the migration, run everything and commit**

```bash
npm run db:migrate
npm test
npm run lint
git add src/lib/epic/tokens.ts src/lib/epic/tokens.test.ts src/lib/db drizzle src/lib/epic/connections.ts src/lib/epic/connections.test.ts src/lib/epic/callback.ts src/lib/epic/callback.test.ts src/app/api/epic/callback
git commit -m "Add token exchange, encrypted connections and SMART callback"
```

---

### Task 8: Fresh access tokens

**Files:**
- Create: `src/lib/epic/access.ts`, `src/lib/epic/access.test.ts`
- Modify: `src/lib/epic/server.ts`

**Interfaces:**
- Consumes: `ConnectionSecrets`, `updateTokens` (Task 7), `refreshAccessToken` (Task 7), `ReconnectRequiredError` (Task 1).
- Produces: `freshAccessToken(connection, deps: { now: Date; refresh: (c: ConnectionSecrets) => Promise<TokenSet>; persist: (id: string, tokens: TokenSet) => Promise<void> }): Promise<string>`; in `server.ts`: `accessTokenFor(connection: ConnectionSecrets): Promise<string>`. Plan 04 calls `accessTokenFor`.

- [ ] **Step 1: Write the failing test `src/lib/epic/access.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { freshAccessToken } from "./access";
import type { ConnectionSecrets } from "./connections";
import { ReconnectRequiredError } from "./errors";

const now = new Date("2026-09-23T10:00:00Z");
const connection = (overrides: Partial<ConnectionSecrets> = {}): ConnectionSecrets => ({
  id: "conn-1",
  organizationName: "Example Health",
  fhirBaseUrl: "https://fhir.example.org/api/FHIR/R4",
  scope: "s",
  connectedAt: now,
  tokenEndpoint: "https://fhir.example.org/oauth2/token",
  patientId: "p",
  accessToken: "at-old",
  refreshToken: "rt",
  accessTokenExpiresAt: new Date("2026-09-23T10:30:00Z"),
  ...overrides,
});

describe("freshAccessToken", () => {
  it("returns the stored token while it has more than a minute left", async () => {
    const refresh = vi.fn();
    expect(await freshAccessToken(connection(), { now, refresh, persist: vi.fn() })).toBe("at-old");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes and persists a token that is about to expire", async () => {
    const newTokens = { accessToken: "at-new", expiresAt: new Date("2026-09-23T11:00:00Z"), scope: "s" };
    const refresh = vi.fn().mockResolvedValue(newTokens);
    const persist = vi.fn().mockResolvedValue(undefined);
    const soon = connection({ accessTokenExpiresAt: new Date("2026-09-23T10:00:30Z") });
    expect(await freshAccessToken(soon, { now, refresh, persist })).toBe("at-new");
    expect(persist).toHaveBeenCalledWith("conn-1", newTokens);
  });

  it("asks for a reconnect when there is no refresh token", async () => {
    const expired = connection({ refreshToken: null, accessTokenExpiresAt: new Date("2026-09-23T09:00:00Z") });
    await expect(freshAccessToken(expired, { now, refresh: vi.fn(), persist: vi.fn() })).rejects.toBeInstanceOf(
      ReconnectRequiredError,
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/epic/access.test.ts`
Expected: FAIL — cannot resolve `./access`.

- [ ] **Step 3: Implement `src/lib/epic/access.ts`**

```ts
import type { ConnectionSecrets } from "./connections";
import { ReconnectRequiredError } from "./errors";
import type { TokenSet } from "./tokens";

const EARLY_EXPIRY_MS = 60_000;

export async function freshAccessToken(
  connection: ConnectionSecrets,
  deps: {
    now: Date;
    refresh: (connection: ConnectionSecrets) => Promise<TokenSet>;
    persist: (id: string, tokens: TokenSet) => Promise<void>;
  },
): Promise<string> {
  if (connection.accessTokenExpiresAt.getTime() - deps.now.getTime() > EARLY_EXPIRY_MS) {
    return connection.accessToken;
  }
  if (!connection.refreshToken) throw new ReconnectRequiredError();
  const tokens = await deps.refresh(connection);
  await deps.persist(connection.id, tokens);
  return tokens.accessToken;
}
```

- [ ] **Step 4: Add `accessTokenFor` to `src/lib/epic/server.ts`**

Add these imports at the top of `src/lib/epic/server.ts`:

```ts
import { db } from "@/lib/db";
import { freshAccessToken } from "./access";
import { updateTokens, type ConnectionSecrets } from "./connections";
import { ReconnectRequiredError } from "./errors";
import { refreshAccessToken } from "./tokens";
```

and append:

```ts
export function accessTokenFor(connection: ConnectionSecrets): Promise<string> {
  return freshAccessToken(connection, {
    now: new Date(),
    refresh: async (c) => {
      if (!c.refreshToken) throw new ReconnectRequiredError();
      return refreshAccessToken({
        tokenEndpoint: c.tokenEndpoint,
        refreshToken: c.refreshToken,
        clientId: env().EPIC_CLIENT_ID,
        clientAssertion: await clientAssertionFor(c.tokenEndpoint),
      });
    },
    persist: (id, tokens) => updateTokens(db, tokenKey(), id, tokens, new Date()),
  });
}
```

- [ ] **Step 5: Run the tests and commit**

```bash
npx vitest run src/lib/epic/access.test.ts
npm run lint
git add src/lib/epic/access.ts src/lib/epic/access.test.ts src/lib/epic/server.ts
git commit -m "Refresh Epic access tokens before they expire"
```

Expected: PASS, 3 tests.

---

### Task 9: Connections page, onboarding connect step and sandbox walkthrough

**Files:**
- Create: `src/components/app/OrgSearch.tsx`, `src/components/app/FinishLater.tsx`, `src/components/app/connections.css`, `src/app/(app)/app/connections/page.tsx`, `src/app/(app)/app/connections/actions.ts`, `src/lib/epic/messages.ts`
- Modify: `src/app/(app)/app/layout.tsx`, `src/app/(app)/app/onboarding/page.tsx`, `src/app/(app)/app/onboarding/ConnectStep.tsx`

**Interfaces:**
- Consumes: `loadDirectory`, `searchOrganizations`, `listConnections`, `deleteConnection`, `SCOPE_LABELS`, `CallbackFailure`, `requireOnboarded`, `finishOnboardingAction`.
- Produces: `OrgSearch({ environment, query, results, formAction })`, `FinishLater()`, `CONNECT_ERRORS: Record<CallbackFailure | "unavailable", string>`, `disconnectAction(formData)`.

- [ ] **Step 1: Register the app with Epic**

Follow **Epic app registration** in the roadmap. Use the Preview deployment's `/api/epic/jwks` as the non-production JWK Set URL, and set `EPIC_CLIENT_ID` in `.env.local` and in Vercel Development and Preview. Wait for Epic's sandbox sync (up to an hour).

- [ ] **Step 2: Create shared messages `src/lib/epic/messages.ts`**

```ts
import type { CallbackFailure } from "./callback";

export const CONNECT_ERRORS: Record<CallbackFailure | "unavailable", string> = {
  denied: "The connection was cancelled on the MyChart page. Nothing was shared.",
  expired: "That sign-in took too long. Please start again.",
  invalid_state: "That sign-in came from a different tab or an old link. Please start again.",
  token_failed: "The health system didn't finish the connection. Please try again in a few minutes.",
  unavailable: "We couldn't reach that health system just now. Please try again later.",
};

export function connectErrorMessage(value: unknown): string | undefined {
  return typeof value === "string" && value in CONNECT_ERRORS
    ? CONNECT_ERRORS[value as keyof typeof CONNECT_ERRORS]
    : undefined;
}
```

- [ ] **Step 3: Create the picker components**

`src/components/app/OrgSearch.tsx`:

```tsx
import type { Organization } from "@/lib/epic/directory";

export function OrgSearch({
  environment,
  query,
  results,
  formAction,
}: {
  environment: "sandbox" | "production";
  query: string;
  results: Organization[];
  formAction: string;
}) {
  return (
    <div className="org-search">
      {environment === "production" ? (
        <form className="org-search-form" action={formAction} method="get" role="search">
          <label className="field">
            Find your health system
            <input name="q" type="search" defaultValue={query} placeholder="Hospital or clinic name" />
          </label>
          <button className="btn" type="submit">
            Search
          </button>
        </form>
      ) : (
        <p className="org-note">
          Early access uses Epic&apos;s test environment. Sign in with one of Epic&apos;s sample MyChart patients.
        </p>
      )}
      {results.length > 0 ? (
        <ul className="org-results">
          {results.map((org) => (
            <li key={org.fhirBaseUrl}>
              <span>{org.name}</span>
              <a className="btn" href={`/api/epic/authorize?iss=${encodeURIComponent(org.fhirBaseUrl)}`}>
                Connect
              </a>
            </li>
          ))}
        </ul>
      ) : query ? (
        <p className="org-note">No health systems match “{query}”. Try a shorter name.</p>
      ) : null}
    </div>
  );
}
```

`src/components/app/FinishLater.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { finishOnboardingAction, type FormState } from "@/app/(app)/app/onboarding/actions";

export function FinishLater() {
  const [, action, pending] = useActionState<FormState, FormData>(finishOnboardingAction, {});
  return (
    <form action={action}>
      <button className="btn btn-ghost" type="submit" disabled={pending}>
        I&apos;ll do this later
      </button>
    </form>
  );
}
```

`src/components/app/connections.css`:

```css
.org-search {
  display: grid;
  gap: 14px;
}

.org-search-form {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  align-items: end;
}

.org-note {
  margin: 0;
  font-size: 15px;
  color: inherit;
  opacity: 0.85;
}

.org-results {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.org-results li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: #fff;
  color: var(--cream-ink);
  border-radius: 999px;
  padding: 8px 8px 8px 22px;
  font-weight: 700;
}

.connections {
  display: grid;
  gap: 40px;
  max-width: 760px;
}

.connection-list {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.connection {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 28px;
  padding: 20px 24px;
}

.connection h3 {
  margin: 0;
  font-size: 19px;
}

.connection p {
  margin: 2px 0 0;
  color: var(--muted);
  font-size: 14px;
}

.panel-light {
  background: var(--vinyl);
  color: var(--cream-ink);
  border-radius: 40px;
  padding: 32px;
}

.panel-light h2,
.connections h2 {
  margin: 0 0 14px;
  font-size: 24px;
  font-weight: 800;
}

.scope-list {
  margin: 0;
  padding-left: 20px;
  color: var(--text-2);
}

.notice {
  margin: 0;
  border-radius: 20px;
  padding: 14px 18px;
  background: var(--surface);
}

.notice-error {
  background: var(--rasp-soft);
  color: var(--text);
}
```

- [ ] **Step 4: Create the disconnect action and connections page**

`src/app/(app)/app/connections/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { deleteConnection } from "@/lib/epic/connections";
import { requireSession } from "@/lib/session";

export async function disconnectAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  await deleteConnection(db, session.user.id, String(formData.get("connectionId") ?? ""));
  revalidatePath("/app/connections");
  revalidatePath("/app");
}
```

`src/app/(app)/app/connections/page.tsx`:

```tsx
import type { Metadata } from "next";
import { OrgSearch } from "@/components/app/OrgSearch";
import { db } from "@/lib/db";
import { SCOPE_LABELS } from "@/lib/epic/authorize";
import { listConnections } from "@/lib/epic/connections";
import { loadDirectory, searchOrganizations } from "@/lib/epic/directory";
import { connectErrorMessage } from "@/lib/epic/messages";
import { env } from "@/lib/env";
import { requireOnboarded } from "@/lib/onboarding-guard";
import { disconnectAction } from "./actions";
import "@/components/auth/auth.css";
import "@/components/app/connections.css";

export const metadata: Metadata = { title: "Connections | Wild Hearts Health" };

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

export default async function ConnectionsPage({ searchParams }: PageProps<"/app/connections">) {
  const { session } = await requireOnboarded();
  const { q, connected, error } = await searchParams;
  const query = typeof q === "string" ? q : "";
  const environment = env().EPIC_ENVIRONMENT;

  const [connections, directory] = await Promise.all([
    listConnections(db, session.user.id),
    loadDirectory(environment).catch(() => null),
  ]);
  const connectedUrls = new Set(connections.map((c) => c.fhirBaseUrl));
  const available = (directory ?? []).filter((org) => !connectedUrls.has(org.fhirBaseUrl));
  const results = environment === "sandbox" || query ? searchOrganizations(available, query) : [];
  const errorMessage = connectErrorMessage(error) ?? (directory ? undefined : connectErrorMessage("unavailable"));

  return (
    <section className="app-page connections">
      <div>
        <h1>Connections</h1>
        <p className="lede">Each health system you connect adds to your record. You can disconnect any of them at any time.</p>
      </div>

      {connected === "1" ? <p className="notice">Connected. Your records from this health system now appear on your dashboard.</p> : null}
      {errorMessage ? (
        <p className="notice notice-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <div>
        <h2>Connected</h2>
        {connections.length === 0 ? (
          <p className="notice">Nothing connected yet.</p>
        ) : (
          <ul className="connection-list">
            {connections.map((connection) => (
              <li className="connection" key={connection.id}>
                <div>
                  <h3>{connection.organizationName}</h3>
                  <p>Connected {dateFormat.format(connection.connectedAt)}</p>
                </div>
                <form action={disconnectAction}>
                  <input type="hidden" name="connectionId" value={connection.id} />
                  <button className="btn btn-ghost" type="submit">
                    Disconnect
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel-light">
        <h2>Add a health system</h2>
        <OrgSearch environment={environment} query={query} results={results} formAction="/app/connections" />
      </div>

      <div>
        <h2>What we ask for</h2>
        <ul className="scope-list">
          {SCOPE_LABELS.map((item) => (
            <li key={item.scope}>{item.label}</li>
          ))}
        </ul>
        <p className="lede">
          Read-only. Disconnecting deletes the access we stored; your records at the health system are not affected.
        </p>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Add Connections to the app nav**

In `src/app/(app)/app/layout.tsx`, change `LINKS` to:

```ts
const LINKS = [
  { href: "/app", label: "Your record" },
  { href: "/app/connections", label: "Connections" },
];
```

- [ ] **Step 6: Replace the onboarding connect step**

Replace `src/app/(app)/app/onboarding/ConnectStep.tsx` with:

```tsx
import { FinishLater } from "@/components/app/FinishLater";
import { OrgSearch } from "@/components/app/OrgSearch";
import { loadDirectory, searchOrganizations } from "@/lib/epic/directory";
import { env } from "@/lib/env";
import "@/components/app/connections.css";

export async function ConnectStep({ query, error }: { query: string; error?: string }) {
  const environment = env().EPIC_ENVIRONMENT;
  const directory = await loadDirectory(environment).catch(() => []);
  const results = environment === "sandbox" || query ? searchOrganizations(directory, query) : [];
  return (
    <div className="auth-form">
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <OrgSearch environment={environment} query={query} results={results} formAction="/app/onboarding" />
      <FinishLater />
    </div>
  );
}
```

In `src/app/(app)/app/onboarding/page.tsx`:
1. Add `import { connectErrorMessage } from "@/lib/epic/messages";`.
2. Change the signature to `export default async function OnboardingPage({ searchParams }: PageProps<"/app/onboarding">) {` and add, after `const current = …`:

```tsx
  const { q, error } = await searchParams;
```

3. Replace `<ConnectStep />` with:

```tsx
<ConnectStep query={typeof q === "string" ? q : ""} error={connectErrorMessage(error)} />
```

- [ ] **Step 7: Walk the full flow against the Epic sandbox**

With `npm run dev` and a fresh test account:
1. Onboarding step 3 lists "Epic sandbox (sample patients)". **Connect** goes to Epic's sandbox MyChart login.
2. Sign in with a sandbox MyChart test patient from Epic's "Sandbox Test Data" page and allow access. You land on `/app` and onboarding is complete.
3. `/app/connections` lists the sandbox org, and "What we ask for" lists seven items.
4. In a database console (`npx drizzle-kit studio`), the `epic_connection` row shows `v1.…` values in the sealed columns and no readable token.
5. Start a connection and click **Cancel/Deny** on the Epic page. You return to `/app/connections` with "The connection was cancelled…".
6. Open `/api/epic/callback?code=x&state=forged` directly. You get "That sign-in came from a different tab…", and no row is added.
7. **Disconnect** removes the row; the page shows "Nothing connected yet."
8. The server log shows no tokens, codes or patient IDs at any point.

- [ ] **Step 8: Run every check, commit and open the PR**

```bash
npm test
npm run lint
npm run build
npm run typecheck
git add src/components/app src/lib/epic/messages.ts "src/app/(app)/app"
git commit -m "Add connections page and Epic connect step in onboarding"
```

Push and open a PR titled "Dashboard 03: Epic SMART on FHIR connection". In the description, list the new env vars (names only), the Epic registration settings used, and the results of the Step 7 walkthrough.
