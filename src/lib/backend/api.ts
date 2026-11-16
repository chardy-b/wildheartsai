import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import type { Profile } from "@/lib/profile";
import type { SourceSummary } from "@/lib/sources";
import { filterQuery, parseCursor } from "@/lib/timeline-filters";
import type { WildcardFile } from "@/lib/wildcards";
import type { DemoSnapshot } from "@/lib/demo/store";
import type { AppSession, Backend, DocumentFhirView, TimelineView } from "./types";

// The backend on Cloudflare: the Hono API Worker (api/), reached over the web Worker's `API`
// service binding, never the public internet. Each call carries the browser's cookie (the API
// finds the person from it) and Cloudflare's client IP (its rate limits key on that). The web
// Worker holds no secrets and no database binding.

type ApiEnv = { API: { fetch(request: Request): Promise<Response> } };

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`API responded ${status}`);
    this.name = "ApiError";
  }
}

async function call(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const { env } = getCloudflareContext() as unknown as { env: ApiEnv };
  const incoming = await headers();
  const forwarded = new Headers({ Accept: "application/json" });
  for (const name of ["cookie", "cf-connecting-ip", "user-agent"]) {
    const value = incoming.get(name);
    if (value) forwarded.set(name, value);
  }
  if (init.body !== undefined) forwarded.set("Content-Type", "application/json");
  // The host is a placeholder: a service binding delivers to the API Worker whatever it says.
  return env.API.fetch(new Request(`https://api.internal${path}`, { method: init.method ?? "GET", headers: forwarded, body: init.body === undefined ? undefined : JSON.stringify(init.body) }));
}

async function json<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await call(path, init);
  if (!response.ok) throw new ApiError(response.status);
  return (await response.json()) as T;
}

const date = (value: unknown): Date | null => (value ? new Date(value as string) : null);

function sourcesFrom(sources: SourceSummary[]): SourceSummary[] {
  return sources.map((s) => ({ ...s, lastSyncedAt: date(s.lastSyncedAt) }));
}

async function sessionFromApi(path: string): Promise<AppSession | null> {
  const response = await call(path);
  if (response.status === 401) return null;
  if (!response.ok) throw new ApiError(response.status);
  const found = (await response.json()) as AppSession;
  return { user: found.user, session: { ...found.session, expiresAt: new Date(found.session.expiresAt) } };
}

const outcome = async (path: string, method = "POST", body?: unknown) => (await json<{ outcome: string }>(path, { method, body })).outcome;

export const apiBackend: Backend = {
  signUpSettings: () => json("/api/signup-settings"),

  // The browser's cookies go along, so the API selects the demo workspace as on Vercel.
  session: () => sessionFromApi("/api/session"),
  realSession: () => sessionFromApi("/api/session?real=1"),

  async profile() {
    const { profile } = await json<{ profile: Profile | null }>("/api/profile");
    if (!profile) return undefined;
    return { ...profile, consentedAt: date(profile.consentedAt), onboardedAt: date(profile.onboardedAt), createdAt: new Date(profile.createdAt), updatedAt: new Date(profile.updatedAt) };
  },
  async savePreferredName(_userId, preferredName) {
    await json("/api/profile/name", { method: "POST", body: { preferredName } });
  },
  // The form was validated before this is called; the API checks again.
  async recordAcknowledgement() {
    await json("/api/profile/acknowledge", { method: "POST", body: { "not-medical-advice": "on", "privacy-notice": "on" } });
  },
  async completeOnboarding() {
    await json("/api/profile/complete", { method: "POST" });
  },

  async sources() {
    return sourcesFrom((await json<{ sources: SourceSummary[] }>("/api/sources")).sources);
  },
  async timeline(_userId, filters, cursor) {
    const view = await json<Omit<TimelineView, "next"> & { next: string | null }>(`/api/records${filterQuery(filters, cursor)}`);
    return { ...view, sources: sourcesFrom(view.sources), next: parseCursor(view.next ?? undefined) };
  },
  note: (_userId, sourceId, attachmentUrl) => json(`/api/records/note?${new URLSearchParams({ sourceId, url: attachmentUrl })}`),

  async exportRecords(_userId, search) {
    const response = await call(`/api/export?${search}`);
    if (!response.ok) throw new ApiError(response.status);
    return new Response(response.body, { headers: response.headers });
  },

  connectChoices: (query) => json(`/api/connections/choices?${new URLSearchParams({ q: query })}`),
  refresh: (_userId, sourceId) => outcome(`/api/sources/${encodeURIComponent(sourceId)}/refresh`),
  refreshAll: () => outcome("/api/sources/refresh"),
  async disconnect(_userId, connectionId) {
    await json(`/api/connections/${encodeURIComponent(connectionId)}/disconnect`, { method: "POST" });
  },
  async deleteSource(_userId, sourceId) {
    await json(`/api/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" });
  },
  async connectMetriport(_userId, personaId) {
    const response = await call("/api/connections/metriport", { method: "POST", body: { persona: personaId } });
    const result = ((await response.json().catch(() => ({}))) as { outcome?: string }).outcome;
    if (!response.ok || !result || result === "unavailable") return "/app/connections?error=unavailable";
    return result === "queued" ? "/app/connections?connected=1" : `/app/connections?refresh=${result}`;
  },

  // R2 is always bound to the API Worker.
  documentsAvailable: () => true,
  documents: (_userId, requested) => json(`/api/wildcards?${new URLSearchParams({ page: String(requested) })}`),
  async document(_userId, id) {
    const response = await call(`/api/wildcards/${encodeURIComponent(id)}/info`);
    if (response.status === 404) return null;
    if (!response.ok) throw new ApiError(response.status);
    return ((await response.json()) as { file: WildcardFile }).file;
  },
  async readyDocuments() {
    const files: WildcardFile[] = [];
    for (let page = 1; ; page++) {
      const listing = (await json(`/api/wildcards?page=${page}`)) as { files: WildcardFile[]; usage: { count: number }; page: number };
      files.push(...listing.files);
      if (listing.page !== page || page * 50 >= listing.usage.count) break;
    }
    return files.filter((f) => f.status === "ready");
  },
  async openDemoWorkspace() {
    await json("/api/demo/workspace", { method: "POST" });
  },
  async demoSnapshot() {
    const response = await call("/api/demo/snapshot");
    if (response.status === 409) return null;
    if (!response.ok) throw new ApiError(response.status);
    return (await response.json()) as DemoSnapshot;
  },
  async documentFhir(_userId, id, runId) {
    const query = runId ? `?${new URLSearchParams({ runId })}` : "";
    const response = await call(`/api/wildcards/${encodeURIComponent(id)}/fhir-view${query}`);
    if (response.status === 404) return null;
    if (response.status === 409) return { error: ((await response.json()) as { error: string }).error };
    if (!response.ok) throw new ApiError(response.status);
    return { data: (await response.json()) as DocumentFhirView };
  },
};
