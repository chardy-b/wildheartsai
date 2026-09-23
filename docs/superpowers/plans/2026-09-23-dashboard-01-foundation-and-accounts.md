# Dashboard 01: Foundation and Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People can create an account, confirm their email, sign in, reset a password and reach a protected `/app` page styled in Nightlight.

**Architecture:** Better Auth runs inside the Next.js app with a Drizzle adapter over Neon Postgres. Validated environment access lives in one module. Auth pages are server components wrapping small client forms that call the Better Auth React client. `src/proxy.ts` does an optimistic cookie check on `/app/*`, and the `/app` layout does the real session check.

**Tech Stack:** Next.js 16.3 (App Router, `proxy.ts`), React 19.2, TypeScript 5, Tailwind 4, Better Auth 1.7 + `@better-auth/drizzle-adapter`, Drizzle ORM 0.45 + drizzle-kit 0.31, `@neondatabase/serverless` 1.1, Zod 4, Vitest 5, PGlite 0.5.

**Spec:** `docs/superpowers/plans/2026-09-23-dashboard-roadmap.md` (read it first) and `docs/creative-direction.md` for every visual decision.

## Global Constraints

- Before writing Next.js code, read the relevant guide in `node_modules/next/dist/docs/` (`AGENTS.md` rule). Middleware is called **Proxy** in Next 16 (`src/proxy.ts`).
- Run `npm run lint`, `npm run typecheck` and `npm run build` before every PR. `typecheck` runs `next typegen` first, which generates the global `LayoutProps` / `PageProps` route types.
- Do not import `server-only` in `src/lib/env.ts`, `src/lib/db/*` or `src/lib/auth.ts`; the Better Auth CLI loads them outside Next.
- Never log or put in a URL: tokens, passwords, email addresses, patient data.
- UI copy follows the voice rules in `docs/creative-direction.md` (patient, literal, no exclamation marks). Colors come only from the tokens in `src/app/globals.css`.
- Password minimum length: **12**. Session lifetime: **7 days**, refreshed daily.
- `SIGNUPS_ENABLED=true` in development and preview, `false` in production.

## File Structure

| File | Responsibility |
| --- | --- |
| `vitest.config.ts` | Test runner config, `@/` alias, `server-only` stub |
| `src/test/setup.ts`, `src/test/empty.ts` | Test env defaults; empty module standing in for `server-only` |
| `src/test/db.ts` | `createTestDb()` — PGlite database with all migrations applied |
| `src/lib/env.ts` | Zod-validated server environment, `appUrl()` |
| `src/lib/db/types.ts`, `src/lib/db/index.ts`, `src/lib/db/schema.ts`, `src/lib/db/auth-schema.ts` | Drizzle types, Neon client, schema barrel, generated Better Auth tables |
| `drizzle.config.ts`, `drizzle/` | drizzle-kit config and generated SQL migrations |
| `src/lib/email.ts`, `src/lib/email-templates.ts` | Email sender (Resend or console) and the two templates |
| `src/lib/auth.ts` | Better Auth server instance |
| `src/app/api/auth/[...all]/route.ts` | Better Auth HTTP handler |
| `src/lib/auth-client.ts`, `src/lib/auth-errors.ts` | Browser client; error-to-copy mapping |
| `src/lib/session.ts` | `getSession()` / `requireSession()` for server components |
| `src/app/(auth)/*` | Sign-in, sign-up, check-email, forgot-password, reset-password pages and forms |
| `src/components/auth/auth.css` | Auth page styles |
| `src/proxy.ts` | Optimistic redirect for `/app/*` without a session cookie |
| `src/app/(app)/app/layout.tsx`, `src/app/(app)/app/page.tsx` | Protected shell and placeholder home |
| `src/components/app/*` | App nav, sign-out button, `app.css` |

---

### Task 1: Test tooling and environment module

**Files:**
- Create: `vitest.config.ts`, `src/test/setup.ts`, `src/test/empty.ts`, `src/lib/env.ts`, `src/lib/env.test.ts`
- Modify: `package.json` (scripts, dependencies)

**Interfaces:**
- Produces: `parseEnv(source: Record<string, string | undefined>): ServerEnv`, `env(): ServerEnv`, `appUrl(): string`, type `ServerEnv`. Later tasks read `env().DATABASE_URL`, `env().BETTER_AUTH_SECRET`, `env().EMAIL_FROM`, `env().RESEND_API_KEY`, `env().SIGNUPS_ENABLED`.

- [ ] **Step 1: Install dependencies**

```bash
npm install zod server-only
npm install -D vitest vite @types/node@^24
```

- [ ] **Step 2: Add scripts to `package.json`**

In `"scripts"`, add:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside Next's server runtime; tests run in plain Node.
      "server-only": fileURLToPath(new URL("./src/test/empty.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

- [ ] **Step 4: Create the test support files**

`src/test/empty.ts`:

```ts
export {};
```

`src/test/setup.ts`:

```ts
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-000";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.EMAIL_FROM ??= "Wild Hearts Health <test@example.com>";
process.env.SIGNUPS_ENABLED ??= "true";
```

- [ ] **Step 5: Write the failing test `src/lib/env.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { parseEnv, resolveAppUrl } from "./env";

const valid = {
  DATABASE_URL: "postgresql://user:pass@ep-example.neon.tech/neondb?sslmode=require",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  EMAIL_FROM: "Wild Hearts Health <hello@example.com>",
};

describe("parseEnv", () => {
  it("accepts a complete environment and defaults sign-ups to off", () => {
    const env = parseEnv(valid);
    expect(env.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(env.SIGNUPS_ENABLED).toBe(false);
    expect(env.RESEND_API_KEY).toBeUndefined();
  });

  it("turns SIGNUPS_ENABLED=true into a boolean", () => {
    expect(parseEnv({ ...valid, SIGNUPS_ENABLED: "true" }).SIGNUPS_ENABLED).toBe(true);
  });

  it("rejects a short auth secret", () => {
    expect(() => parseEnv({ ...valid, BETTER_AUTH_SECRET: "short" })).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("rejects a missing database URL", () => {
    const { DATABASE_URL: _omit, ...rest } = valid;
    void _omit;
    expect(() => parseEnv(rest)).toThrow(/DATABASE_URL/);
  });
});

describe("resolveAppUrl", () => {
  it("prefers BETTER_AUTH_URL", () => {
    expect(resolveAppUrl({ BETTER_AUTH_URL: "https://app.example.com", VERCEL_URL: "x.vercel.app" })).toBe(
      "https://app.example.com",
    );
  });

  it("falls back to the Vercel deployment URL", () => {
    expect(resolveAppUrl({ VERCEL_URL: "wildhearts-git-branch.vercel.app" })).toBe(
      "https://wildhearts-git-branch.vercel.app",
    );
  });

  it("throws when neither is set", () => {
    expect(() => resolveAppUrl({})).toThrow(/BETTER_AUTH_URL/);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/lib/env.test.ts`
Expected: FAIL — `Failed to resolve import "./env"`.

- [ ] **Step 7: Implement `src/lib/env.ts`**

```ts
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.url().optional(),
  VERCEL_URL: z.string().optional(),
  EMAIL_FROM: z.string().min(3),
  RESEND_API_KEY: z.string().min(1).optional(),
  SIGNUPS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type ServerEnv = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined>): ServerEnv {
  return schema.parse(source);
}

let cached: ServerEnv | undefined;

export function env(): ServerEnv {
  cached ??= parseEnv(process.env);
  return cached;
}

// The public origin of this deployment. Preview deployments on Vercel have no
// fixed domain, so fall back to the per-deployment URL Vercel provides.
export function resolveAppUrl(source: { BETTER_AUTH_URL?: string; VERCEL_URL?: string }): string {
  if (source.BETTER_AUTH_URL) return source.BETTER_AUTH_URL;
  if (source.VERCEL_URL) return `https://${source.VERCEL_URL}`;
  throw new Error("Set BETTER_AUTH_URL (or deploy on Vercel, which sets VERCEL_URL)");
}

export function appUrl(): string {
  return resolveAppUrl(env());
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/lib/env.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 9: Lint and commit**

```bash
npm run lint
git add package.json package-lock.json vitest.config.ts src/test src/lib/env.ts src/lib/env.test.ts
git commit -m "Add Vitest and a validated server environment module"
```

---

### Task 2: Email sender and templates

**Files:**
- Create: `src/lib/email.ts`, `src/lib/email.test.ts`, `src/lib/email-templates.ts`, `src/lib/email-templates.test.ts`

**Interfaces:**
- Consumes: `env()` from Task 1.
- Produces: `type Email = { to: string; subject: string; text: string }`, `createEmailSender(options): SendEmail`, `sendEmail(email: Email): Promise<void>`, `verificationEmail({ to, url }): Email`, `passwordResetEmail({ to, url }): Email`.

- [ ] **Step 1: Write the failing tests**

`src/lib/email.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createEmailSender } from "./email";

const email = { to: "person@example.com", subject: "Confirm your email", text: "Open https://x.test/verify" };

describe("createEmailSender", () => {
  it("logs subject and body without the recipient when there is no API key in development", async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn();
    await createEmailSender({ from: "WH <hi@example.com>", production: false, log, fetchImpl })(email);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain("Confirm your email");
    expect(line).toContain("https://x.test/verify");
    expect(line).not.toContain("person@example.com");
  });

  it("refuses to run without an API key in production", () => {
    expect(() => createEmailSender({ from: "WH <hi@example.com>", production: true })).toThrow(/RESEND_API_KEY/);
  });

  it("posts to Resend when an API key is set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await createEmailSender({ apiKey: "re_test", from: "WH <hi@example.com>", production: true, fetchImpl })(email);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer re_test");
    expect(JSON.parse(init.body)).toEqual({
      from: "WH <hi@example.com>",
      to: ["person@example.com"],
      subject: "Confirm your email",
      text: "Open https://x.test/verify",
    });
  });

  it("throws when Resend rejects the message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 422 }));
    const send = createEmailSender({ apiKey: "re_test", from: "WH <hi@example.com>", production: true, fetchImpl });
    await expect(send(email)).rejects.toThrow("Email provider responded 422");
  });
});
```

`src/lib/email-templates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { passwordResetEmail, verificationEmail } from "./email-templates";

describe("email templates", () => {
  it("builds the verification email around the link", () => {
    const email = verificationEmail({ to: "a@example.com", url: "https://app.test/verify?token=t" });
    expect(email.to).toBe("a@example.com");
    expect(email.subject).toBe("Confirm your email for Wild Hearts Health");
    expect(email.text).toContain("https://app.test/verify?token=t");
    expect(email.text).not.toMatch(/!/);
  });

  it("builds the password reset email around the link", () => {
    const email = passwordResetEmail({ to: "a@example.com", url: "https://app.test/reset?token=t" });
    expect(email.subject).toBe("Reset your Wild Hearts Health password");
    expect(email.text).toContain("https://app.test/reset?token=t");
    expect(email.text).toContain("you can ignore this email");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/email.test.ts src/lib/email-templates.test.ts`
Expected: FAIL — cannot resolve `./email` and `./email-templates`.

- [ ] **Step 3: Implement `src/lib/email.ts`**

```ts
import { env } from "@/lib/env";

export type Email = { to: string; subject: string; text: string };
export type SendEmail = (email: Email) => Promise<void>;

type Options = {
  apiKey?: string;
  from: string;
  production: boolean;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
};

export function createEmailSender({
  apiKey,
  from,
  production,
  fetchImpl = fetch,
  log = console.info,
}: Options): SendEmail {
  if (!apiKey) {
    if (production) throw new Error("RESEND_API_KEY is required in production");
    // Development only: print the message so the link can be opened locally.
    // The recipient is left out on purpose.
    return async (email) => log(`[email] ${email.subject}\n${email.text}`);
  }

  return async (email) => {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [email.to], subject: email.subject, text: email.text }),
    });
    if (!response.ok) throw new Error(`Email provider responded ${response.status}`);
  };
}

export function sendEmail(email: Email): Promise<void> {
  const { RESEND_API_KEY, EMAIL_FROM } = env();
  return createEmailSender({
    apiKey: RESEND_API_KEY,
    from: EMAIL_FROM,
    production: process.env.NODE_ENV === "production",
  })(email);
}
```

- [ ] **Step 4: Implement `src/lib/email-templates.ts`**

```ts
import type { Email } from "./email";

type LinkEmail = { to: string; url: string };

export function verificationEmail({ to, url }: LinkEmail): Email {
  return {
    to,
    subject: "Confirm your email for Wild Hearts Health",
    text: [
      "Hello,",
      "",
      "Confirm your email to finish creating your Wild Hearts Health account:",
      url,
      "",
      "If you didn't create an account, you can ignore this email.",
      "",
      "Wild Hearts Health",
    ].join("\n"),
  };
}

export function passwordResetEmail({ to, url }: LinkEmail): Email {
  return {
    to,
    subject: "Reset your Wild Hearts Health password",
    text: [
      "Hello,",
      "",
      "Use this link to choose a new password. It expires in one hour:",
      url,
      "",
      "If you didn't ask to reset your password, you can ignore this email.",
      "",
      "Wild Hearts Health",
    ].join("\n"),
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/email.test.ts src/lib/email-templates.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/email.ts src/lib/email.test.ts src/lib/email-templates.ts src/lib/email-templates.test.ts
git commit -m "Add email sender with Resend and development console output"
```

---

### Task 3: Neon database and Better Auth server

**Files:**
- Create: `drizzle.config.ts`, `src/lib/db/types.ts`, `src/lib/db/index.ts`, `src/lib/db/schema.ts`, `src/lib/db/auth-schema.ts` (generated), `src/lib/db/schema.test.ts`, `src/test/db.ts`, `src/lib/auth.ts`, `src/app/api/auth/[...all]/route.ts`, `drizzle/*.sql` (generated)
- Modify: `package.json`, `.env.example`

**Interfaces:**
- Consumes: `env()`, `appUrl()` (Task 1), `sendEmail`, `verificationEmail`, `passwordResetEmail` (Task 2).
- Produces: `type Db` (a Drizzle Postgres database over the full schema), `db: Db`, `createTestDb(): Promise<Db>`, `auth` (Better Auth instance), table exports `user`, `session`, `account`, `verification` from `src/lib/db/schema.ts`.

- [ ] **Step 1: Provision Neon (manual, once)**

In the Vercel dashboard for this project: **Storage → Marketplace → Neon → Create**, connect it to Development, Preview and Production. Then pull the variables locally:

```bash
npx vercel link
npx vercel env pull .env.local
```

Confirm `.env.local` contains `DATABASE_URL`. Add the rest of the variables to Vercel (Development and Preview) and to `.env.local`:

```bash
# 32+ random characters
BETTER_AUTH_SECRET=<output of: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))">
BETTER_AUTH_URL=http://localhost:3000
EMAIL_FROM=Wild Hearts Health <hello@wildheartsai.com>
SIGNUPS_ENABLED=true
```

In Vercel **Production**, set `SIGNUPS_ENABLED=false` and leave `BETTER_AUTH_URL` for the production domain. Leave `BETTER_AUTH_URL` unset in **Preview**, so `appUrl()` uses `VERCEL_URL`.

- [ ] **Step 2: Install dependencies and add scripts**

```bash
npm install better-auth @better-auth/drizzle-adapter drizzle-orm @neondatabase/serverless
npm install -D drizzle-kit @electric-sql/pglite
```

Add to `"scripts"` in `package.json`:

```json
"db:generate": "drizzle-kit generate",
"db:migrate": "drizzle-kit migrate",
"auth:schema": "npx auth@1.7.5 generate --config src/lib/auth.ts --output src/lib/db/auth-schema.ts"
```

- [ ] **Step 3: Create `drizzle.config.ts`**

```ts
import { loadEnvConfig } from "@next/env";
import { defineConfig } from "drizzle-kit";

loadEnvConfig(process.cwd());

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
```

- [ ] **Step 4: Create the database modules**

`src/lib/db/schema.ts` (temporarily empty; Step 7 fills it):

```ts
export {};
```

`src/lib/db/types.ts`:

```ts
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

// Neon (production) and PGlite (tests) both implement Drizzle's Postgres API.
// Repositories accept this type so tests can pass an in-memory database.
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
```

`src/lib/db/index.ts`:

```ts
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { env } from "@/lib/env";
import * as schema from "./schema";
import type { Db } from "./types";

// The cast erases Neon's driver-specific result type; queries are identical.
export const db = drizzle(neon(env().DATABASE_URL), { schema }) as unknown as Db;

export type { Db };
```

- [ ] **Step 5: Create `src/lib/auth.ts`**

```ts
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { passwordResetEmail, verificationEmail } from "@/lib/email-templates";
import { appUrl, env } from "@/lib/env";

const DAY = 60 * 60 * 24;

export const auth = betterAuth({
  baseURL: appUrl(),
  secret: env().BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: !env().SIGNUPS_ENABLED,
    requireEmailVerification: true,
    minPasswordLength: 12,
    sendResetPassword: async ({ user, url }) => {
      await sendEmail(passwordResetEmail({ to: user.email, url }));
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail(verificationEmail({ to: user.email, url }));
    },
  },
  session: { expiresIn: 7 * DAY, updateAge: DAY },
  plugins: [nextCookies()],
});
```

- [ ] **Step 6: Generate the Better Auth schema**

Run: `npm run auth:schema`
Expected: `src/lib/db/auth-schema.ts` is created and exports `user`, `session`, `account` and `verification` as `pgTable(...)` definitions. If the CLI reports an unknown flag, run `npx auth@1.7.5 generate --help` and use its equivalent of `--config` and `--output`; the output file path must stay `src/lib/db/auth-schema.ts`.

- [ ] **Step 7: Point the schema barrel at the generated tables**

Replace `src/lib/db/schema.ts` with:

```ts
export * from "./auth-schema";
```

- [ ] **Step 8: Write the failing migration test**

`src/test/db.ts`:

```ts
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

// An in-memory Postgres with every migration in drizzle/ applied.
export async function createTestDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: "drizzle" });
  return db as unknown as Db;
}
```

`src/lib/db/schema.test.ts`:

```ts
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/test/db";

describe("database migrations", () => {
  it("create the Better Auth tables", async () => {
    const db = await createTestDb();
    const result = await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    const names = (result.rows as { table_name: string }[]).map((row) => row.table_name);
    expect(names).toEqual(expect.arrayContaining(["account", "session", "user", "verification"]));
  });
});
```

- [ ] **Step 9: Run it to verify it fails**

Run: `npx vitest run src/lib/db/schema.test.ts`
Expected: FAIL — the migrator cannot find `drizzle/meta/_journal.json`.

- [ ] **Step 10: Generate the migration and re-run**

```bash
npm run db:generate
npx vitest run src/lib/db/schema.test.ts
```

Expected: `drizzle/0000_*.sql` is created; the test PASSES.

- [ ] **Step 11: Apply the migration to the Neon development branch**

Run: `npm run db:migrate`
Expected: drizzle-kit reports the migration applied, with no errors.

- [ ] **Step 12: Mount the Better Auth handler**

`src/app/api/auth/[...all]/route.ts`:

```ts
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

export const { GET, POST } = toNextJsHandler(auth);
```

- [ ] **Step 13: Smoke-test the handler**

Run `npm run dev`, then in a second terminal:

```bash
curl -s http://localhost:3000/api/auth/get-session
```

Expected: `null` (no session), HTTP 200.

- [ ] **Step 14: Update `.env.example`**

Replace the file with:

```bash
# Public canonical URL for local metadata previews. Vercel supplies its production URL automatically.
NEXT_PUBLIC_SITE_URL=http://localhost:3000

# Server-only configuration. Real values live in Vercel; pull them with `npx vercel env pull .env.local`.

# Neon Postgres (provisioned through the Vercel Marketplace)
DATABASE_URL=postgresql://user:password@host/neondb?sslmode=require

# Better Auth
BETTER_AUTH_SECRET=replace-with-32-plus-random-characters
BETTER_AUTH_URL=http://localhost:3000
SIGNUPS_ENABLED=true

# Email (verification and reset links only; never health information)
EMAIL_FROM=Wild Hearts Health <hello@wildheartsai.com>
RESEND_API_KEY=

# Epic SMART on FHIR (plan 03 adds these)
EPIC_ENVIRONMENT=sandbox
EPIC_CLIENT_ID=replace-with-epic-non-production-client-id
EPIC_REDIRECT_URI=http://localhost:3000/api/epic/callback
```

- [ ] **Step 15: Run the checks and commit**

```bash
npm test
npm run lint
npm run build
npm run typecheck
git add drizzle.config.ts drizzle src/lib/db src/test/db.ts src/lib/auth.ts "src/app/api/auth" package.json package-lock.json .env.example
git commit -m "Add Neon, Drizzle and Better Auth with email verification"
```

---

### Task 4: Shared buttons, auth client and sign-up / sign-in pages

**Files:**
- Modify: `src/app/globals.css`, `src/components/landing/landing.css`
- Create: `src/lib/auth-client.ts`, `src/lib/auth-errors.ts`, `src/lib/auth-errors.test.ts`, `src/components/auth/auth.css`, `src/components/auth/AuthCard.tsx`, `src/app/(auth)/layout.tsx`, `src/app/(auth)/sign-in/page.tsx`, `src/app/(auth)/sign-in/SignInForm.tsx`, `src/app/(auth)/sign-up/page.tsx`, `src/app/(auth)/sign-up/SignUpForm.tsx`, `src/app/(auth)/check-email/page.tsx`

**Interfaces:**
- Consumes: `auth` routes from Task 3, `env().SIGNUPS_ENABLED`, `CONTACT_HREF` from `src/components/landing/contact.ts`, `HeartMark` and `FaceMark` from `src/components/landing/marks.tsx`.
- Produces: `authClient`, `authErrorMessage(error: AuthError): string`, `AuthCard({ title, lede, children })`, CSS classes `auth-form`, `field`, `field-hint`, `form-error`, `form-notice`, `auth-links`.

- [ ] **Step 1: Move shared button and container styles into `globals.css`**

Cut these rule blocks from `src/components/landing/landing.css` — `.wrap`, `.btn`, `.btn:hover`, `.btn-lg`, `.btn-ghost`, `.btn-ghost:hover` — and paste them unchanged at the end of `src/app/globals.css`, above the `@media (prefers-reduced-motion: reduce)` block. Then append to `globals.css`, inside the existing file:

```css
button.btn {
  border: 0;
  cursor: pointer;
  font-family: inherit;
}

.btn:disabled {
  opacity: 0.6;
  cursor: progress;
  transform: none;
}

@media (max-width: 900px) {
  .wrap {
    width: calc(100% - 32px);
  }
}
```

Remove `.wrap { width: calc(100% - 32px); }` from the `@media (max-width: 900px)` block in `landing.css`. Run `npm run build` and open `/` to confirm the landing page looks unchanged.

- [ ] **Step 2: Write the failing test `src/lib/auth-errors.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { authErrorMessage } from "./auth-errors";

describe("authErrorMessage", () => {
  it.each([
    [{ code: "EMAIL_NOT_VERIFIED", status: 403 }, "Please confirm your email first. We sent you a link when you signed up."],
    [{ code: "USER_ALREADY_EXISTS", status: 422 }, "An account with this email already exists. Try signing in instead."],
    [{ code: "INVALID_EMAIL_OR_PASSWORD", status: 401 }, "That email and password don't match. Try again or reset your password."],
    [{ code: "PASSWORD_TOO_SHORT", status: 400 }, "Use at least 12 characters for your password."],
    [{ status: 429 }, "Too many attempts. Wait a minute, then try again."],
    [{ status: 500 }, "Something went wrong on our side. Please try again."],
  ])("maps %o to calm copy", (error, message) => {
    expect(authErrorMessage(error)).toBe(message);
  });

  it("falls back to status codes when the code is missing", () => {
    expect(authErrorMessage({ status: 403 })).toMatch(/confirm your email/);
    expect(authErrorMessage({ status: 401 })).toMatch(/don't match/);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/lib/auth-errors.test.ts`
Expected: FAIL — cannot resolve `./auth-errors`.

- [ ] **Step 4: Implement `src/lib/auth-errors.ts` and `src/lib/auth-client.ts`**

`src/lib/auth-errors.ts`:

```ts
export type AuthError = { status?: number; code?: string; message?: string };

export function authErrorMessage(error: AuthError): string {
  switch (error.code) {
    case "PASSWORD_TOO_SHORT":
      return "Use at least 12 characters for your password.";
    case "EMAIL_NOT_VERIFIED":
      return "Please confirm your email first. We sent you a link when you signed up.";
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return "An account with this email already exists. Try signing in instead.";
    case "INVALID_EMAIL_OR_PASSWORD":
      return "That email and password don't match. Try again or reset your password.";
  }
  switch (error.status) {
    case 401:
      return "That email and password don't match. Try again or reset your password.";
    case 403:
      return "Please confirm your email first. We sent you a link when you signed up.";
    case 422:
      return "An account with this email already exists. Try signing in instead.";
    case 429:
      return "Too many attempts. Wait a minute, then try again.";
    default:
      return "Something went wrong on our side. Please try again.";
  }
}
```

`src/lib/auth-client.ts`:

```ts
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/auth-errors.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Create the auth layout and styles**

`src/components/auth/auth.css`:

```css
.auth-shell {
  min-height: 100vh;
  display: grid;
  grid-template-rows: auto 1fr;
  background: radial-gradient(520px 520px at 50% 45%, rgb(255 214 196 / 0.07), transparent 70%) no-repeat;
}

.auth-top {
  display: flex;
  align-items: center;
  height: 88px;
}

.auth-brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-weight: 800;
  font-size: 17.5px;
  text-decoration: none;
}

.auth-brand svg {
  width: 21px;
  height: 21px;
}

.auth-main {
  display: grid;
  place-items: center;
  padding: 24px 0 96px;
}

.auth-card {
  width: min(460px, 100%);
  background: var(--vinyl);
  color: var(--cream-ink);
  border-radius: 40px;
  padding: 44px clamp(24px, 6vw, 44px) 36px;
  box-shadow: 0 0 140px 10px rgb(255 214 196 / 0.07), var(--drop);
}

.auth-card .avatar {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: #fff;
  display: grid;
  place-items: center;
  margin-bottom: 20px;
  box-shadow: 0 6px 16px -6px rgb(60 40 48 / 0.4);
}

.auth-card .avatar svg {
  width: 28px;
}

.auth-card h1 {
  margin: 0;
  font-size: 30px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.2;
}

.auth-lede {
  margin: 10px 0 26px;
  color: var(--cream-ink-2);
}

.auth-form {
  display: grid;
  gap: 16px;
}

.field {
  display: grid;
  gap: 6px;
  font-weight: 700;
  font-size: 15px;
}

.field input {
  height: 50px;
  border-radius: 16px;
  border: 1px solid #d9cec8;
  background: #fff;
  color: var(--cream-ink);
  padding: 0 16px;
  font: inherit;
  font-weight: 500;
}

.field input:focus-visible {
  outline: 3px solid var(--rasp-btn);
  outline-offset: 1px;
  border-radius: 16px;
}

.field-hint {
  font-weight: 400;
  font-size: 13.5px;
  color: var(--cream-ink-2);
}

.form-error,
.form-notice {
  margin: 0;
  border-radius: 16px;
  padding: 12px 16px;
  font-size: 15px;
}

.form-error {
  background: #fbe3eb;
  color: var(--rasp-btn);
}

.form-notice {
  background: #ffffff;
  color: var(--cream-ink);
}

.auth-form .btn {
  width: 100%;
  margin-top: 6px;
}

.auth-links {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 22px;
  font-size: 14.5px;
  color: var(--cream-ink-2);
}

.auth-links a {
  color: var(--rasp-btn);
  font-weight: 700;
}
```

`src/components/auth/AuthCard.tsx`:

```tsx
import type { ReactNode } from "react";
import { FaceMark } from "@/components/landing/marks";

export function AuthCard({ title, lede, children }: { title: string; lede?: string; children: ReactNode }) {
  return (
    <section className="auth-card" aria-labelledby="auth-title">
      <span className="avatar">
        <FaceMark />
      </span>
      <h1 id="auth-title">{title}</h1>
      {lede ? <p className="auth-lede">{lede}</p> : null}
      {children}
    </section>
  );
}
```

`src/app/(auth)/layout.tsx`:

```tsx
import type { ReactNode } from "react";
import { HeartMark } from "@/components/landing/marks";
import "@/components/auth/auth.css";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <header className="wrap auth-top">
        <a className="auth-brand" href="/" aria-label="Wild Hearts Health home">
          <HeartMark />
          Wild Hearts Health
        </a>
      </header>
      <main className="wrap auth-main" id="main-content">
        {children}
      </main>
    </div>
  );
}
```

- [ ] **Step 7: Create the sign-in page**

`src/app/(auth)/sign-in/SignInForm.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-errors";

export function SignInForm({ notice }: { notice?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { error } = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setPending(false);
    if (error) {
      setError(authErrorMessage(error));
      return;
    }
    router.push("/app");
    router.refresh();
  }

  return (
    <form className="auth-form" onSubmit={onSubmit}>
      {notice ? <p className="form-notice">{notice}</p> : null}
      <label className="field">
        Email
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label className="field">
        Password
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="btn btn-lg" type="submit" disabled={pending}>
        {pending ? "Signing in" : "Sign in"}
      </button>
    </form>
  );
}
```

`src/app/(auth)/sign-in/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/AuthCard";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = { title: "Sign in | Wild Hearts Health" };

const NOTICES: Record<string, string> = {
  reset: "Your password is updated. Sign in with the new one.",
};

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { notice } = await searchParams;
  return (
    <AuthCard title="Welcome back." lede="Sign in to see your record.">
      <SignInForm notice={typeof notice === "string" ? NOTICES[notice] : undefined} />
      <p className="auth-links">
        <Link href="/forgot-password">Forgot your password?</Link>
        <Link href="/sign-up">Create an account</Link>
      </p>
    </AuthCard>
  );
}
```

- [ ] **Step 8: Create the sign-up and check-email pages**

`src/app/(auth)/sign-up/SignUpForm.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-errors";

export function SignUpForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { error } = await authClient.signUp.email({
      name: String(form.get("name")).trim(),
      email: String(form.get("email")),
      password: String(form.get("password")),
      callbackURL: "/app",
    });
    setPending(false);
    if (error) {
      setError(authErrorMessage(error));
      return;
    }
    router.push("/check-email");
  }

  return (
    <form className="auth-form" onSubmit={onSubmit}>
      <label className="field">
        What should we call you?
        <input name="name" type="text" autoComplete="given-name" maxLength={60} required />
      </label>
      <label className="field">
        Email
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label className="field">
        Password
        <input name="password" type="password" autoComplete="new-password" minLength={12} required />
        <span className="field-hint">At least 12 characters.</span>
      </label>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="btn btn-lg" type="submit" disabled={pending}>
        {pending ? "Creating your account" : "Create account"}
      </button>
    </form>
  );
}
```

`src/app/(auth)/sign-up/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/AuthCard";
import { CONTACT_HREF } from "@/components/landing/contact";
import { env } from "@/lib/env";
import { SignUpForm } from "./SignUpForm";

export const metadata: Metadata = { title: "Create an account | Wild Hearts Health" };

export default function SignUpPage() {
  if (!env().SIGNUPS_ENABLED) {
    return (
      <AuthCard
        title="Early access is by invitation."
        lede="We're letting people in slowly. Tell us a little about your care and we'll be in touch."
      >
        <a className="btn btn-lg" href={CONTACT_HREF}>
          Contact us
        </a>
        <p className="auth-links">
          <Link href="/sign-in">Already invited? Sign in</Link>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Create your account." lede="You'll confirm your email, then connect your first health system.">
      <SignUpForm />
      <p className="auth-links">
        <Link href="/sign-in">Already have an account? Sign in</Link>
      </p>
    </AuthCard>
  );
}
```

`src/app/(auth)/check-email/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/AuthCard";

export const metadata: Metadata = { title: "Check your email | Wild Hearts Health" };

export default function CheckEmailPage() {
  return (
    <AuthCard
      title="Check your email."
      lede="We sent a link to confirm your address. Open it on this device to finish signing up."
    >
      <p className="auth-links">
        <Link href="/sign-in">Back to sign in</Link>
      </p>
    </AuthCard>
  );
}
```

- [ ] **Step 9: Verify in the browser**

Run `npm run dev` and check:
1. `/sign-up` renders the cream card. Submitting a new email shows `/check-email`, and the dev terminal prints `[email] Confirm your email for Wild Hearts Health` with a link and no email address.
2. Signing in before confirming shows "Please confirm your email first…".
3. Opening the printed link signs you in and lands on `/app` (it returns 404 until Task 6).
4. Signing up twice with the same email shows "An account with this email already exists…".
5. With `SIGNUPS_ENABLED=false` in `.env.local` (restart dev), `/sign-up` shows the invitation card. Set it back to `true`.

- [ ] **Step 10: Commit**

```bash
npm test
npm run lint
git add src/app/globals.css src/components/landing/landing.css src/lib/auth-client.ts src/lib/auth-errors.ts src/lib/auth-errors.test.ts src/components/auth "src/app/(auth)"
git commit -m "Add sign-up, sign-in and check-email pages"
```

---

### Task 5: Password reset pages

**Files:**
- Create: `src/app/(auth)/forgot-password/page.tsx`, `src/app/(auth)/forgot-password/ForgotPasswordForm.tsx`, `src/app/(auth)/reset-password/page.tsx`, `src/app/(auth)/reset-password/ResetPasswordForm.tsx`

**Interfaces:**
- Consumes: `authClient`, `authErrorMessage`, `AuthCard`, the auth CSS classes (Task 4).
- Produces: `/forgot-password` and `/reset-password` pages. Better Auth sends users to `/reset-password?token=…` or `/reset-password?error=INVALID_TOKEN`.

- [ ] **Step 1: Create the forgot-password page**

`src/app/(auth)/forgot-password/ForgotPasswordForm.tsx`:

```tsx
"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    // The response is ignored on purpose: we never reveal whether an account exists.
    await authClient.requestPasswordReset({ email: String(form.get("email")), redirectTo: "/reset-password" });
    setPending(false);
    setSent(true);
  }

  if (sent) {
    return <p className="form-notice">If an account exists for that email, a reset link is on its way.</p>;
  }

  return (
    <form className="auth-form" onSubmit={onSubmit}>
      <label className="field">
        Email
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <button className="btn btn-lg" type="submit" disabled={pending}>
        {pending ? "Sending" : "Send reset link"}
      </button>
    </form>
  );
}
```

`src/app/(auth)/forgot-password/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/AuthCard";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

export const metadata: Metadata = { title: "Reset your password | Wild Hearts Health" };

export default function ForgotPasswordPage() {
  return (
    <AuthCard title="Reset your password." lede="We'll email you a link to choose a new one.">
      <ForgotPasswordForm />
      <p className="auth-links">
        <Link href="/sign-in">Back to sign in</Link>
      </p>
    </AuthCard>
  );
}
```

- [ ] **Step 2: Create the reset-password page**

`src/app/(auth)/reset-password/ResetPasswordForm.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-errors";

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { error } = await authClient.resetPassword({ newPassword: String(form.get("password")), token });
    setPending(false);
    if (error) {
      setError(authErrorMessage(error));
      return;
    }
    router.push("/sign-in?notice=reset");
  }

  return (
    <form className="auth-form" onSubmit={onSubmit}>
      <label className="field">
        New password
        <input name="password" type="password" autoComplete="new-password" minLength={12} required />
        <span className="field-hint">At least 12 characters.</span>
      </label>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="btn btn-lg" type="submit" disabled={pending}>
        {pending ? "Saving" : "Save new password"}
      </button>
    </form>
  );
}
```

`src/app/(auth)/reset-password/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth/AuthCard";
import { ResetPasswordForm } from "./ResetPasswordForm";

export const metadata: Metadata = { title: "Choose a new password | Wild Hearts Health" };

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const { token, error } = await searchParams;

  if (error || typeof token !== "string") {
    return (
      <AuthCard title="That link has expired." lede="Reset links work once and last an hour. Ask for a new one.">
        <Link className="btn btn-lg" href="/forgot-password">
          Send a new link
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password.">
      <ResetPasswordForm token={token} />
    </AuthCard>
  );
}
```

- [ ] **Step 3: Verify in the browser**

With `npm run dev`:
1. `/forgot-password` → submit your test email → the confirmation text appears; the terminal prints the reset email with its link.
2. Submitting an unknown email shows the same confirmation text.
3. Opening the link lands on `/reset-password?token=…`; a new 12+ character password redirects to `/sign-in?notice=reset` with the notice shown; signing in with it works.
4. Opening the same link again shows "That link has expired."

- [ ] **Step 4: Commit**

```bash
npm run lint
git add "src/app/(auth)/forgot-password" "src/app/(auth)/reset-password"
git commit -m "Add password reset pages"
```

---

### Task 6: Protected app shell, proxy and landing sign-in link

**Files:**
- Create: `src/proxy.ts`, `src/proxy.test.ts`, `src/lib/session.ts`, `src/components/app/app.css`, `src/components/app/AppNav.tsx`, `src/components/app/SignOutButton.tsx`, `src/app/(app)/app/layout.tsx`, `src/app/(app)/app/page.tsx`
- Modify: `src/components/landing/Nav.tsx`

**Interfaces:**
- Consumes: `auth` (Task 3), `authClient` (Task 4), `HeartMark` / `FaceMark`.
- Produces: `getSession(): Promise<Session | null>` (request-deduplicated), `requireSession(): Promise<Session>` (redirects to `/sign-in`), `AppNav({ links })` with `links: { href: string; label: string }[]`, CSS classes `app-shell`, `app-main`, `app-page`, `app-footer`. Plans 02–04 import these.

- [ ] **Step 1: Write the failing proxy test `src/proxy.test.ts`**

```ts
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "./proxy";

describe("proxy", () => {
  it("redirects /app requests without a session cookie to sign-in", () => {
    const response = proxy(new NextRequest("http://localhost:3000/app"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/sign-in");
  });

  it("lets requests with a session cookie through", () => {
    const request = new NextRequest("http://localhost:3000/app", {
      headers: { cookie: "better-auth.session_token=abc.def" },
    });
    const response = proxy(request);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/proxy.test.ts`
Expected: FAIL — cannot resolve `./proxy`.

- [ ] **Step 3: Implement `src/proxy.ts`**

```ts
import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

// Optimistic check only: it keeps signed-out visitors away from /app quickly.
// The real session check happens in src/app/(app)/app/layout.tsx.
export function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/app/:path*"],
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/proxy.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Create `src/lib/session.ts`**

```ts
import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/lib/auth";

export const getSession = cache(async () => auth.api.getSession({ headers: await headers() }));

export type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return session;
}
```

- [ ] **Step 6: Create the app shell**

`src/components/app/app.css`:

```css
.app-shell {
  min-height: 100vh;
  display: grid;
  grid-template-rows: auto 1fr auto;
}

.app-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 80px;
  border-bottom: 2px dotted var(--line);
}

.app-nav-links {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
  font-size: 15px;
}

.app-nav-links a {
  text-decoration: none;
  padding: 8px 14px;
  border-radius: 999px;
  color: var(--text-2);
}

.app-nav-links a:hover,
.app-nav-links a[aria-current="page"] {
  background: var(--surface);
  color: var(--text);
}

.app-brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-weight: 800;
  text-decoration: none;
  white-space: nowrap;
}

.app-brand svg {
  width: 21px;
  height: 21px;
}

.app-main {
  padding: clamp(32px, 5vw, 64px) 0 96px;
}

.app-page h1 {
  margin: 0;
  font-size: clamp(32px, 4vw, 48px);
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.15;
}

.app-page .lede {
  color: var(--text-2);
  max-width: 44ch;
  margin: 14px 0 0;
}

.app-footer {
  padding: 24px 0 32px;
  font-size: 13px;
  color: var(--muted);
  border-top: 2px dotted var(--line);
}

@media (max-width: 700px) {
  .app-nav-links a {
    padding: 8px 10px;
  }
}
```

`src/components/app/SignOutButton.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      className="btn btn-ghost"
      type="button"
      onClick={async () => {
        await authClient.signOut();
        router.push("/");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
```

`src/components/app/AppNav.tsx`:

```tsx
import Link from "next/link";
import { HeartMark } from "@/components/landing/marks";
import { SignOutButton } from "./SignOutButton";

export type NavLink = { href: string; label: string };

export function AppNav({ links }: { links: NavLink[] }) {
  return (
    <header className="wrap app-nav">
      <Link className="app-brand" href="/app" aria-label="Wild Hearts Health dashboard">
        <HeartMark />
        Wild Hearts Health
      </Link>
      <nav className="app-nav-links" aria-label="Dashboard">
        {links.map((link) => (
          <Link key={link.href} href={link.href}>
            {link.label}
          </Link>
        ))}
        <SignOutButton />
      </nav>
    </header>
  );
}
```

`src/app/(app)/app/layout.tsx`:

```tsx
import { AppNav } from "@/components/app/AppNav";
import { requireSession } from "@/lib/session";
import "@/components/app/app.css";

const LINKS = [{ href: "/app", label: "Your record" }];

export default async function AppLayout({ children }: LayoutProps<"/app">) {
  await requireSession();
  return (
    <div className="app-shell">
      <AppNav links={LINKS} />
      <main className="wrap app-main" id="main-content">
        {children}
      </main>
      <footer className="wrap app-footer">
        Wild Hearts Health is not a medical provider and does not give medical advice.
      </footer>
    </div>
  );
}
```

`src/app/(app)/app/page.tsx`:

```tsx
import type { Metadata } from "next";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Your record | Wild Hearts Health" };

export default async function AppHome() {
  const session = await requireSession();
  return (
    <section className="app-page">
      <h1>Welcome, {session.user.name}.</h1>
      <p className="lede">Your record will gather here once you connect a health system.</p>
    </section>
  );
}
```

- [ ] **Step 7: Add "Sign in" to the landing nav**

In `src/components/landing/Nav.tsx`, replace the comment line
`{/* Sign in goes here as a nav-link once login ships; Contact us stays primary. */}` with:

```tsx
<a className="nav-link" href="/sign-in">
  Sign in
</a>
```

- [ ] **Step 8: Verify in the browser**

With `npm run dev`:
1. Signed out, `/app` redirects to `/sign-in`.
2. After signing in, `/app` shows "Welcome, {name}." inside the Nightlight shell; "Sign out" returns you to `/`, and `/app` redirects again.
3. The landing nav shows "Sign in" before "Contact us" on desktop.
4. Deleting the `better-auth.session_token` cookie value in DevTools while on `/app` and reloading sends you to `/sign-in` (the layout check, not just the proxy).

- [ ] **Step 9: Run every check and commit**

```bash
npm test
npm run lint
npm run build
npm run typecheck
git add src/proxy.ts src/proxy.test.ts src/lib/session.ts src/components/app "src/app/(app)" src/components/landing/Nav.tsx
git commit -m "Add protected app shell, session helpers and sign-in link"
```

- [ ] **Step 10: Open the PR**

Push the branch and open a PR titled "Dashboard 01: accounts and protected app shell". In the description, list the Vercel env vars added (names only) and the manual checks from Tasks 4–6.
