import "server-only";
import { auth } from "@/lib/auth";
import { applicationSession } from "@/lib/application-session";
import { recordAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { asUser } from "@/lib/db/rls";
import { deleteConnection } from "@/lib/epic/connections";
import { connectChoices } from "@/lib/epic/directory-store";
import { appUrl, enabledEpicEnvironment, env } from "@/lib/env";
import { exportBundle, exportFilename } from "@/lib/export";
import { deleteMetriportConnection } from "@/lib/metriport/connections";
import { personaById } from "@/lib/metriport/personas";
import { connectSandboxPersona, metriportEnabled } from "@/lib/metriport/server";
import { CONSENT_VERSION } from "@/lib/onboarding";
import { completeOnboarding, getProfile, recordAcknowledgement, savePreferredName } from "@/lib/profile";
import { loadExportFor, loadNoteFor, loadSourcesFor, loadTimelineFor } from "@/lib/records-server";
import { deleteSource, listSources } from "@/lib/sources";
import { requestSyncFor } from "@/lib/sync/server";
import { parseFilters } from "@/lib/timeline";
import { recordsKey } from "@/lib/records-keys";
import { fileMetadata, fileUsage, listFiles } from "@/lib/wildcards-store";
import { r2Configured } from "@/lib/wildcards-r2";
import { documentsPage } from "@/lib/wildcards";
import { DocumentFhirError, loadDocumentFhir } from "@/lib/extraction/fhir-store";
import { demoSnapshot } from "@/lib/demo/store";
import { ensureDemoWorkspace } from "@/lib/demo/workspace";
import type { Backend } from "./types";

// The backend as on Vercel today: Postgres through the app's own modules. Logic moved here from
// the server actions and the export route unchanged. Removed after the Cloudflare cutover.

function failedToQueue(error: unknown): "failed" {
  console.error("[sync] queueing failed", error instanceof Error ? error.name : "unknown");
  return "failed";
}

export const directBackend: Backend = {
  signUpSettings: async () => ({ signupsEnabled: env().SIGNUPS_ENABLED, inviteRequired: Boolean(env().SIGNUP_INVITE_CODE) }),

  session: (requestHeaders) => applicationSession(requestHeaders),
  realSession: (requestHeaders) => auth.api.getSession({ headers: requestHeaders, query: { disableRefresh: true } }),

  profile: (userId) => getProfile(db, userId),
  savePreferredName: (userId, preferredName) => savePreferredName(db, userId, preferredName, new Date()),
  recordAcknowledgement: (userId) => recordAcknowledgement(db, userId, CONSENT_VERSION, new Date()),
  completeOnboarding: (userId) => completeOnboarding(db, userId, new Date()),

  sources: (userId) => loadSourcesFor(userId),
  timeline: (userId, filters, cursor) => loadTimelineFor(userId, filters, cursor),
  note: (userId, sourceId, attachmentUrl) => loadNoteFor(userId, sourceId, attachmentUrl),

  async exportRecords(userId, search) {
    const params = Object.fromEntries([...new Set(search.keys())].map((key) => [key, search.getAll(key)]));
    const filters = parseFilters(params, await loadSourcesFor(userId));
    const { sources, items } = await loadExportFor(userId, filters);
    const now = new Date();
    const filtered = filters.sourceIds.length > 0 || filters.categories.length > 0 || filters.from !== null || filters.to !== null;
    await asUser(db, userId, (tx) => recordAudit(tx, { userId, action: "export", detail: { records: items.length, filtered } }, now));
    return new Response(JSON.stringify(exportBundle(items, sources, now), null, 2), {
      headers: {
        "Content-Type": "application/fhir+json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(filters, now)}"`,
        "Cache-Control": "private, no-store",
      },
    });
  },

  async connectChoices(query) {
    const config = env();
    const environment = enabledEpicEnvironment(config);
    const choices = await connectChoices(db, environment, query, new Set()).catch(() => null);
    return { settings: { environment, expandedScopes: config.EPIC_EXPANDED_SCOPES, metriportEnabled: metriportEnabled() }, choices };
  },

  refresh: (userId, sourceId) => requestSyncFor(userId, sourceId, "manual").catch(failedToQueue),

  async refreshAll(userId) {
    const sources = (await asUser(db, userId, (tx) => listSources(tx, userId))).filter((s) => s.status === "connected");
    const outcomes = await Promise.all(sources.map((s) => requestSyncFor(userId, s.id, "manual").catch(failedToQueue)));
    // One message for the lot: queued if any started, otherwise the most telling reason.
    return (["queued", "already_running", "cooldown", "failed"] as const).find((o) => (outcomes as string[]).includes(o)) ?? "not_connected";
  },

  async disconnect(userId, connectionId) {
    await asUser(db, userId, async (tx) => {
      if (!(await deleteConnection(tx, userId, connectionId))) await deleteMetriportConnection(tx, userId, connectionId);
    });
  },

  async deleteSource(userId, sourceId) {
    await asUser(db, userId, (tx) => deleteSource(tx, userId, sourceId));
  },

  async connectMetriport(userId, personaId) {
    const persona = personaById(personaId);
    if (!persona || !metriportEnabled()) return "/app/connections?error=unavailable";
    let sourceId: string;
    try {
      ({ sourceId } = await connectSandboxPersona(userId, persona));
    } catch (error) {
      console.error("[metriport] connect failed", error instanceof Error ? error.name : "unknown");
      return "/app/connections?error=unavailable";
    }
    const outcome = await requestSyncFor(userId, sourceId, "connect").catch(failedToQueue);
    return outcome === "queued" ? "/app/connections?connected=1" : `/app/connections?refresh=${outcome}`;
  },

  documentsAvailable: () => r2Configured(),
  async documents(userId, requested) {
    const usage = await fileUsage(db, userId);
    const page = documentsPage(requested, usage.count);
    return { files: await listFiles(db, recordsKey(), userId, page), usage, page };
  },
  document: (userId, id) => fileMetadata(db, recordsKey(), userId, id),
  async readyDocuments(userId) {
    const usage = await fileUsage(db, userId);
    const files = [];
    for (let page = 1; page <= Math.ceil(usage.count / 50); page++) files.push(...(await listFiles(db, recordsKey(), userId, page)));
    return files.filter((f) => f.status === "ready");
  },
  openDemoWorkspace: (identity) => ensureDemoWorkspace(db, recordsKey(), identity),
  demoSnapshot: (userId) => demoSnapshot(db, recordsKey(), userId),
  // Guest demos exist only on Cloudflare; Vercel keeps the signed-in demo until the cutover.
  guestDemoAvailable: () => false,
  openGuestDemo: () => Promise.reject(new Error("guest_demo_unavailable")),
  endGuestDemo: async () => {},
  async documentFhir(userId, id, runId) {
    try {
      const data = await loadDocumentFhir(db, recordsKey(), userId, id, appUrl(), runId);
      return data ? { data } : null;
    } catch (error) {
      if (error instanceof DocumentFhirError) return { error: error.message };
      throw error;
    }
  },
};
