# Dashboard 02: Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After confirming their email, a person is walked through three short steps (what to call them, two early-access acknowledgements, connecting a health system) before they reach their dashboard.

**Architecture:** A `profile` table keyed by the Better Auth user ID stores the preferred name, the acknowledgement version and time, and when onboarding finished. A pure `onboardingStep(profile)` function decides the current step. `/app/onboarding` renders that step with server actions, and `requireOnboarded()` sends anyone who hasn't finished back to it. Bumping `CONSENT_VERSION` makes everyone re-acknowledge on their next visit.

**Tech Stack:** Next.js 16 server actions with React 19 `useActionState`, Drizzle ORM, Zod 4, Vitest + PGlite.

**Spec:** `docs/superpowers/plans/2026-09-23-dashboard-roadmap.md`, `docs/creative-direction.md`. Requires plan 01 merged.

## Global Constraints

- Everything in plan 01's Global Constraints applies.
- The acknowledgements must not reference a privacy policy or terms until those exist (production gate). V1 asks for exactly two: not medical advice, and sandbox data during early access.
- Copy follows the voice rules: patient, literal, no exclamation marks, never medical reassurance.
- Server actions validate with Zod and return `{ error }` for invalid input; they never throw for user mistakes.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/db/profile-schema.ts` | `profile` table |
| `src/lib/onboarding.ts` | `CONSENT_VERSION`, `ACKNOWLEDGEMENTS`, Zod schemas, `onboardingStep()` |
| `src/lib/profile.ts` | Profile repository (read, save name, record acknowledgement, complete) |
| `src/lib/onboarding-guard.ts` | `requireOnboarded()` for dashboard pages |
| `src/app/(app)/app/onboarding/*` | Page, server actions, step components, styles |
| `src/test/db.ts` | Gains `createTestUser()` |

---

### Task 1: Profile table, onboarding rules and repository

**Files:**
- Create: `src/lib/db/profile-schema.ts`, `src/lib/onboarding.ts`, `src/lib/onboarding.test.ts`, `src/lib/profile.ts`, `src/lib/profile.test.ts`
- Modify: `src/lib/db/schema.ts`, `src/test/db.ts`
- Generated: `drizzle/0001_*.sql`

**Interfaces:**
- Consumes: `Db`, `createTestDb()`, `user` table (plan 01).
- Produces:
  - `profile` table; `type Profile = typeof profile.$inferSelect`
  - `CONSENT_VERSION: string`, `ACKNOWLEDGEMENTS: readonly { id: "not-medical-advice" | "test-environment"; text: string }[]`
  - `nameSchema`, `acknowledgeSchema` (Zod)
  - `type OnboardingStep = "name" | "acknowledge" | "connect" | "done"`, `onboardingStep(profile: Profile | undefined): OnboardingStep`
  - `getProfile(db, userId): Promise<Profile | undefined>`, `savePreferredName(db, userId, name, now)`, `recordAcknowledgement(db, userId, version, now)`, `completeOnboarding(db, userId, now)`
  - `createTestUser(db, id?): Promise<string>` in `src/test/db.ts`

- [ ] **Step 1: Add the table**

`src/lib/db/profile-schema.ts`:

```ts
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const profile = pgTable("profile", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  preferredName: text("preferred_name"),
  consentVersion: text("consent_version"),
  consentedAt: timestamp("consented_at", { withTimezone: true }),
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Replace `src/lib/db/schema.ts` with:

```ts
export * from "./auth-schema";
export * from "./profile-schema";
```

- [ ] **Step 2: Add `createTestUser` to `src/test/db.ts`**

Append:

```ts
import { user } from "@/lib/db/schema";

export async function createTestUser(db: Db, id = "user_test_1"): Promise<string> {
  const now = new Date();
  await db.insert(user).values({
    id,
    name: "Test Person",
    email: `${id}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}
```

Move the new `import` to the top of the file with the others.

- [ ] **Step 3: Write the failing tests**

`src/lib/onboarding.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { acknowledgeSchema, CONSENT_VERSION, nameSchema, onboardingStep } from "./onboarding";
import type { Profile } from "./profile";

const base: Profile = {
  userId: "u1",
  preferredName: null,
  consentVersion: null,
  consentedAt: null,
  onboardedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe("onboardingStep", () => {
  it("starts at the name step with no profile", () => {
    expect(onboardingStep(undefined)).toBe("name");
  });

  it("moves through name, acknowledge, connect, done", () => {
    expect(onboardingStep(base)).toBe("name");
    const named = { ...base, preferredName: "Sam" };
    expect(onboardingStep(named)).toBe("acknowledge");
    const acknowledged = { ...named, consentVersion: CONSENT_VERSION, consentedAt: new Date() };
    expect(onboardingStep(acknowledged)).toBe("connect");
    expect(onboardingStep({ ...acknowledged, onboardedAt: new Date() })).toBe("done");
  });

  it("asks again when the acknowledgement version changes", () => {
    const outdated = { ...base, preferredName: "Sam", consentVersion: "older", onboardedAt: new Date() };
    expect(onboardingStep(outdated)).toBe("acknowledge");
  });
});

describe("nameSchema", () => {
  it("trims and accepts a name", () => {
    expect(nameSchema.parse({ preferredName: "  Sam  " })).toEqual({ preferredName: "Sam" });
  });

  it("rejects an empty or very long name", () => {
    expect(nameSchema.safeParse({ preferredName: "   " }).success).toBe(false);
    expect(nameSchema.safeParse({ preferredName: "x".repeat(61) }).success).toBe(false);
  });
});

describe("acknowledgeSchema", () => {
  it("requires both statements to be checked", () => {
    expect(acknowledgeSchema.safeParse({ "not-medical-advice": "on", "test-environment": "on" }).success).toBe(true);
    const missing = acknowledgeSchema.safeParse({ "not-medical-advice": "on" });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]?.message).toBe("Please confirm both statements to continue.");
  });
});
```

`src/lib/profile.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, createTestUser } from "@/test/db";
import type { Db } from "@/lib/db/types";
import { completeOnboarding, getProfile, recordAcknowledgement, savePreferredName } from "./profile";

let db: Db;
let userId: string;

beforeEach(async () => {
  db = await createTestDb();
  userId = await createTestUser(db);
});

describe("profile repository", () => {
  it("returns undefined before anything is saved", async () => {
    expect(await getProfile(db, userId)).toBeUndefined();
  });

  it("creates the profile on first save and updates it after", async () => {
    await savePreferredName(db, userId, "Sam", new Date("2026-09-23T10:00:00Z"));
    await savePreferredName(db, userId, "Samantha", new Date("2026-09-23T10:05:00Z"));
    const saved = await getProfile(db, userId);
    expect(saved?.preferredName).toBe("Samantha");
    expect(saved?.updatedAt.toISOString()).toBe("2026-09-23T10:05:00.000Z");
  });

  it("records the acknowledgement version and completion time", async () => {
    await savePreferredName(db, userId, "Sam", new Date());
    await recordAcknowledgement(db, userId, "v-test", new Date("2026-09-23T11:00:00Z"));
    await completeOnboarding(db, userId, new Date("2026-09-23T11:01:00Z"));
    const saved = await getProfile(db, userId);
    expect(saved?.consentVersion).toBe("v-test");
    expect(saved?.consentedAt?.toISOString()).toBe("2026-09-23T11:00:00.000Z");
    expect(saved?.onboardedAt?.toISOString()).toBe("2026-09-23T11:01:00.000Z");
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run src/lib/onboarding.test.ts src/lib/profile.test.ts`
Expected: FAIL — cannot resolve `./onboarding` and `./profile`.

- [ ] **Step 5: Implement `src/lib/onboarding.ts`**

```ts
import { z } from "zod";
import type { Profile } from "./profile";

// Bump this whenever ACKNOWLEDGEMENTS change; everyone re-acknowledges on their next visit.
export const CONSENT_VERSION = "2026-09-early-access-1";

export const ACKNOWLEDGEMENTS = [
  {
    id: "not-medical-advice",
    text: "Wild Hearts Health is not a medical provider and does not give medical advice. I'll bring questions about my health to my care team.",
  },
  {
    id: "test-environment",
    text: "During early access, connections use Epic's test environment and sample patients, not my real records.",
  },
] as const;

export const nameSchema = z.object({
  preferredName: z
    .string()
    .trim()
    .min(1, "Tell us what to call you.")
    .max(60, "Keep it under 60 characters."),
});

const confirmed = z.literal("on", { error: "Please confirm both statements to continue." });

export const acknowledgeSchema = z.object({
  "not-medical-advice": confirmed,
  "test-environment": confirmed,
});

export type OnboardingStep = "name" | "acknowledge" | "connect" | "done";

export function onboardingStep(profile: Profile | undefined): OnboardingStep {
  if (!profile?.preferredName) return "name";
  if (profile.consentVersion !== CONSENT_VERSION) return "acknowledge";
  if (!profile.onboardedAt) return "connect";
  return "done";
}
```

- [ ] **Step 6: Implement `src/lib/profile.ts`**

```ts
import { eq } from "drizzle-orm";
import { profile } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

export type Profile = typeof profile.$inferSelect;

export async function getProfile(db: Db, userId: string): Promise<Profile | undefined> {
  const [row] = await db.select().from(profile).where(eq(profile.userId, userId)).limit(1);
  return row;
}

async function upsert(db: Db, userId: string, now: Date, fields: Partial<Profile>) {
  await db
    .insert(profile)
    .values({ userId, ...fields, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: profile.userId, set: { ...fields, updatedAt: now } });
}

export function savePreferredName(db: Db, userId: string, preferredName: string, now: Date) {
  return upsert(db, userId, now, { preferredName });
}

export function recordAcknowledgement(db: Db, userId: string, consentVersion: string, now: Date) {
  return upsert(db, userId, now, { consentVersion, consentedAt: now });
}

export function completeOnboarding(db: Db, userId: string, now: Date) {
  return upsert(db, userId, now, { onboardedAt: now });
}
```

- [ ] **Step 7: Generate the migration and run the tests**

```bash
npm run db:generate
npx vitest run src/lib/onboarding.test.ts src/lib/profile.test.ts
```

Expected: `drizzle/0001_*.sql` creates `profile`; PASS, 9 tests.

- [ ] **Step 8: Apply the migration and commit**

```bash
npm run db:migrate
npm test
git add src/lib/db drizzle src/lib/onboarding.ts src/lib/onboarding.test.ts src/lib/profile.ts src/lib/profile.test.ts src/test/db.ts
git commit -m "Add profile table and onboarding rules"
```

---

### Task 2: Onboarding page, actions and dashboard gate

**Files:**
- Create: `src/app/(app)/app/onboarding/page.tsx`, `src/app/(app)/app/onboarding/actions.ts`, `src/app/(app)/app/onboarding/NameStep.tsx`, `src/app/(app)/app/onboarding/AcknowledgeStep.tsx`, `src/app/(app)/app/onboarding/ConnectStep.tsx`, `src/app/(app)/app/onboarding/onboarding.css`, `src/lib/onboarding-guard.ts`
- Modify: `src/app/(app)/app/page.tsx`

**Interfaces:**
- Consumes: `requireSession()`, `AuthCard`, `auth.css` classes (plan 01); everything Task 1 produces.
- Produces: `saveNameAction`, `acknowledgeAction`, `finishOnboardingAction` (server actions, `(prev: FormState, formData: FormData) => Promise<FormState>` with `type FormState = { error?: string }`); `requireOnboarded(): Promise<{ session: Session; profile: Profile }>`. Plan 03 replaces `ConnectStep.tsx`.

- [ ] **Step 1: Create the server actions**

`src/app/(app)/app/onboarding/actions.ts`:

```ts
"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { acknowledgeSchema, CONSENT_VERSION, nameSchema } from "@/lib/onboarding";
import { completeOnboarding, recordAcknowledgement, savePreferredName } from "@/lib/profile";
import { requireSession } from "@/lib/session";

export type FormState = { error?: string };

export async function saveNameAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireSession();
  const parsed = nameSchema.safeParse({ preferredName: String(formData.get("preferredName") ?? "") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  await savePreferredName(db, session.user.id, parsed.data.preferredName, new Date());
  redirect("/app/onboarding");
}

export async function acknowledgeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await requireSession();
  const parsed = acknowledgeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  await recordAcknowledgement(db, session.user.id, CONSENT_VERSION, new Date());
  redirect("/app/onboarding");
}

export async function finishOnboardingAction(): Promise<FormState> {
  const session = await requireSession();
  await completeOnboarding(db, session.user.id, new Date());
  redirect("/app");
}
```

- [ ] **Step 2: Create the step components**

`src/app/(app)/app/onboarding/NameStep.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { saveNameAction, type FormState } from "./actions";

export function NameStep({ defaultName }: { defaultName: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveNameAction, {});
  return (
    <form className="auth-form" action={action}>
      <label className="field">
        Your name
        <input name="preferredName" type="text" defaultValue={defaultName} maxLength={60} autoComplete="given-name" required />
        <span className="field-hint">It doesn't need to match your medical record.</span>
      </label>
      {state.error ? (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button className="btn btn-lg" type="submit" disabled={pending}>
        Continue
      </button>
    </form>
  );
}
```

`src/app/(app)/app/onboarding/AcknowledgeStep.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { ACKNOWLEDGEMENTS } from "@/lib/onboarding";
import { acknowledgeAction, type FormState } from "./actions";

export function AcknowledgeStep() {
  const [state, action, pending] = useActionState<FormState, FormData>(acknowledgeAction, {});
  return (
    <form className="auth-form" action={action}>
      <fieldset className="ack-list">
        <legend className="visually-hidden">Early access acknowledgements</legend>
        {ACKNOWLEDGEMENTS.map((item) => (
          <label className="ack" key={item.id}>
            <input type="checkbox" name={item.id} required />
            <span>{item.text}</span>
          </label>
        ))}
      </fieldset>
      {state.error ? (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button className="btn btn-lg" type="submit" disabled={pending}>
        I understand
      </button>
    </form>
  );
}
```

`src/app/(app)/app/onboarding/ConnectStep.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { finishOnboardingAction, type FormState } from "./actions";

// Plan 03 replaces this with the health-system search.
export function ConnectStep() {
  const [, action, pending] = useActionState<FormState, FormData>(finishOnboardingAction, {});
  return (
    <form className="auth-form" action={action}>
      <p className="form-notice">You'll be able to connect a health system from your dashboard.</p>
      <button className="btn btn-lg" type="submit" disabled={pending}>
        Go to my dashboard
      </button>
    </form>
  );
}
```

- [ ] **Step 3: Create the page and styles**

`src/app/(app)/app/onboarding/onboarding.css`:

```css
.onboarding {
  display: grid;
  justify-items: center;
  gap: 28px;
}

.ob-steps {
  display: flex;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ob-steps li {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-weight: 800;
  font-size: 14px;
  background: var(--surface);
  color: var(--muted);
}

.ob-steps li[aria-current="step"] {
  background: var(--rasp-soft);
  color: var(--rasp-text);
}

.ob-steps li.ob-done {
  background: var(--rasp-btn);
  color: #fff;
}

.ack-list {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  border: 0;
}

.ack {
  display: grid;
  grid-template-columns: 22px 1fr;
  gap: 12px;
  align-items: start;
  background: #fff;
  border-radius: 18px;
  padding: 14px 16px;
  font-size: 15.5px;
  line-height: 1.55;
}

.ack input {
  width: 20px;
  height: 20px;
  margin: 2px 0 0;
  accent-color: var(--rasp-btn);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
```

`src/app/(app)/app/onboarding/page.tsx`:

```tsx
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/AuthCard";
import { db } from "@/lib/db";
import { onboardingStep, type OnboardingStep } from "@/lib/onboarding";
import { getProfile } from "@/lib/profile";
import { requireSession } from "@/lib/session";
import { AcknowledgeStep } from "./AcknowledgeStep";
import { ConnectStep } from "./ConnectStep";
import { NameStep } from "./NameStep";
import "@/components/auth/auth.css";
import "./onboarding.css";

export const metadata: Metadata = { title: "Getting started | Wild Hearts Health" };

const ORDER: OnboardingStep[] = ["name", "acknowledge", "connect"];

export default async function OnboardingPage() {
  const session = await requireSession();
  const step = onboardingStep(await getProfile(db, session.user.id));
  if (step === "done") redirect("/app");
  const current = ORDER.indexOf(step);

  return (
    <div className="onboarding">
      <ol className="ob-steps" aria-label="Getting started progress">
        {ORDER.map((name, i) => (
          <li
            key={name}
            className={i < current ? "ob-done" : undefined}
            aria-current={i === current ? "step" : undefined}
          >
            {i + 1}
          </li>
        ))}
      </ol>
      {step === "name" ? (
        <AuthCard title="What should we call you?" lede="We'll use this name around the app.">
          <NameStep defaultName={session.user.name} />
        </AuthCard>
      ) : null}
      {step === "acknowledge" ? (
        <AuthCard title="Before we start." lede="Two things to know about early access.">
          <AcknowledgeStep />
        </AuthCard>
      ) : null}
      {step === "connect" ? (
        <AuthCard
          title="Connect your first health system."
          lede="You'll sign in on your health system's own MyChart page. We never see your MyChart password."
        >
          <ConnectStep />
        </AuthCard>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Create the guard and use it on the dashboard home**

`src/lib/onboarding-guard.ts`:

```ts
import "server-only";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { onboardingStep } from "@/lib/onboarding";
import { getProfile, type Profile } from "@/lib/profile";
import { requireSession, type Session } from "@/lib/session";

export async function requireOnboarded(): Promise<{ session: Session; profile: Profile }> {
  const session = await requireSession();
  const profile = await getProfile(db, session.user.id);
  if (!profile || onboardingStep(profile) !== "done") redirect("/app/onboarding");
  return { session, profile };
}
```

Replace `src/app/(app)/app/page.tsx` with:

```tsx
import type { Metadata } from "next";
import { requireOnboarded } from "@/lib/onboarding-guard";

export const metadata: Metadata = { title: "Your record | Wild Hearts Health" };

export default async function AppHome() {
  const { profile } = await requireOnboarded();
  return (
    <section className="app-page">
      <h1>Welcome, {profile.preferredName}.</h1>
      <p className="lede">Your record will gather here once you connect a health system.</p>
    </section>
  );
}
```

- [ ] **Step 5: Verify in the browser**

With `npm run dev` and a freshly verified test account:
1. `/app` redirects to `/app/onboarding`, step 1 is highlighted, and the name field is prefilled with the sign-up name.
2. Clearing the name and submitting shows "Tell us what to call you."
3. Step 2: submitting with one box checked is blocked by the browser; removing `required` in DevTools and submitting shows "Please confirm both statements to continue."
4. Step 3 → "Go to my dashboard" lands on `/app` with "Welcome, {preferred name}."
5. Visiting `/app/onboarding` again redirects to `/app`.
6. Changing `CONSENT_VERSION` locally sends you back to step 2 on the next `/app` visit; revert the change afterwards.

- [ ] **Step 6: Run every check, commit and open the PR**

```bash
npm test
npm run lint
npm run build
npm run typecheck
git add "src/app/(app)/app" src/lib/onboarding-guard.ts
git commit -m "Add three-step onboarding and dashboard gate"
```

Push and open a PR titled "Dashboard 02: onboarding", listing the manual checks from Step 5.
