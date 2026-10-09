import type { Metadata } from "next";
import { OrgSearch } from "@/components/app/OrgSearch";
import { SyncWatcher } from "@/components/app/SyncWatcher";
import { missingScopes, scopeLabels } from "@/lib/epic/authorize";
import { db } from "@/lib/db";
import { isSampleData } from "@/lib/epic/directory";
import { connectChoices } from "@/lib/epic/directory-store";
import { connectErrorMessage } from "@/lib/epic/messages";
import { enabledEpicEnvironment, env } from "@/lib/env";
import { metriportEnabled } from "@/lib/metriport/server";
import { isMetriportSource, PERSONAS } from "@/lib/metriport/personas";
import { requireOnboarded } from "@/lib/onboarding-guard";
import { loadSourcesFor } from "@/lib/records-server";
import { labelFor } from "@/lib/fhir/categories";
import type { RecordCategory } from "@/lib/fhir/normalize";
import { ago, categoryCounts, lastRunIssues, listOf } from "@/lib/source-display";
import type { SourceSummary } from "@/lib/sources";
import { connectMetriportSandboxAction, deleteSourceAction, disconnectAction, refreshAction, refreshAllAction } from "./actions";
import "@/components/auth/auth.css";
import "@/components/app/connections.css";

export const metadata: Metadata = { title: "Connections | Wild Hearts Health" };

const REFRESH_MESSAGES: Record<string, { text: string; error?: boolean }> = {
  queued: { text: "Checking for new records. They'll appear on your dashboard in a few minutes." },
  already_running: { text: "We're already checking for new records from that health system." },
  cooldown: { text: "We checked a few minutes ago. Try again shortly." },
  not_connected: { text: "Reconnect that health system to check for new records.", error: true },
  failed: { text: "We couldn't start checking for new records. Please try again.", error: true },
};

function sourceStatus(source: SourceSummary, now: Date): string {
  const records = `${source.recordCount.toLocaleString("en-US")} record${source.recordCount === 1 ? "" : "s"}`;
  if (source.syncing) return source.lastSyncedAt ? `Checking for new records… ${records}` : `Importing your records… ${records} so far`;
  if (source.status === "disconnected") return `Disconnected · ${records} kept`;
  if (source.status === "reconnect_required") return `Needs you to sign in again · ${records}`;
  if (!source.lastSyncedAt) return "Waiting to import your records";
  return `${records} · updated ${ago(source.lastSyncedAt, now)}`;
}

// Short names for what reconnecting adds; the referenced-resource scopes read as one phrase.
const GAINS: Record<string, string> = {
  "patient/Appointment.rs": "appointments",
  "patient/FamilyMemberHistory.rs": "family history",
};
const MORE_DETAIL = "more detail on your records";

// What a connected source would gain from reconnecting: the scopes we now ask for that it
// wasn't granted (for example after EPIC_EXPANDED_SCOPES), in a few words.
function newPermissions(source: SourceSummary, expanded: boolean): string[] {
  if (source.status !== "connected" || source.grantedScope === null) return [];
  const names = missingScopes(source.grantedScope, expanded).map((scope) => GAINS[scope] ?? MORE_DETAIL);
  return [...new Set(names)].sort((a, b) => Number(a === MORE_DETAIL) - Number(b === MORE_DETAIL));
}

function SourceIssues({ source }: { source: SourceSummary }) {
  if (source.syncing || source.status === "disconnected") return null;
  const { failed, truncated } = lastRunIssues(source.lastRunStats);
  const names = (categories: RecordCategory[]) => listOf(categories.map((c) => labelFor(c).toLowerCase()));
  return (
    <>
      {source.lastSyncStatus === "failed" && !failed.length ? <p className="source-issue">We couldn&apos;t finish importing records. Refresh to try again.</p> : null}
      {failed.length ? <p className="source-issue">Last time we couldn&apos;t load {names(failed)}. Refresh to try again.</p> : null}
      {truncated.length ? <p className="source-issue">There were more {names(truncated)} than we could import at once.</p> : null}
    </>
  );
}

export default async function ConnectionsPage({ searchParams }: PageProps<"/app/connections">) {
  const { session } = await requireOnboarded();
  const { q, connected, error, refresh, deleted } = await searchParams;
  const query = typeof q === "string" ? q : "";
  const environment = enabledEpicEnvironment(env());
  const expanded = env().EPIC_EXPANDED_SCOPES;

  const sources = await loadSourcesFor(session.user.id);
  const now = new Date();
  const connectedUrls = new Set(sources.filter((s) => s.status !== "disconnected").map((s) => s.fhirBaseUrl));
  const choices = await connectChoices(db, environment, query, connectedUrls).catch(() => null);
  const { results, sample } = choices ?? { results: [], sample: null };
  const refreshMessage = typeof refresh === "string" ? REFRESH_MESSAGES[refresh] : undefined;
  const errorMessage = connectErrorMessage(error) ?? (choices ? undefined : connectErrorMessage("unavailable"));

  return (
    <section className="app-page connections">
      <div>
        <h1>Connections</h1>
        <p className="lede">Each health system you connect adds to your record. You can disconnect any of them at any time.</p>
      </div>

      {connected === "1" ? (
        <p className="notice">Connected. We&apos;re importing your records now; they&apos;ll fill your dashboard over the next few minutes.</p>
      ) : null}
      {deleted === "1" ? <p className="notice">Deleted. Records from that health system are no longer stored.</p> : null}
      {refreshMessage ? (
        <p className={refreshMessage.error ? "notice notice-error" : "notice"} role={refreshMessage.error ? "alert" : "status"}>
          {refreshMessage.text}
        </p>
      ) : null}
      {errorMessage ? (
        <p className="notice notice-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <div className="panel-light">
        <h2>Add a health system</h2>
        <OrgSearch environment={environment} query={query} results={results} sample={sample} formAction="/app/connections" />
      </div>

      {metriportEnabled() ? (
        <div className="panel-light">
          <h2>Try the Metriport sandbox</h2>
          <p className="lede">
            Pull a sample patient&apos;s records the way they&apos;d arrive from health information exchanges. These are made-up
            people, so there&apos;s nothing to sign in to: pick one and their records import into your dashboard.
          </p>
          <p>Structured records and note summaries are imported. Full note text and document files aren&apos;t included yet.</p>
          <ul className="connection-list">
            {PERSONAS.map((persona) => {
              const connectedAlready = sources.some((s) => s.fhirBaseUrl === `metriport:sandbox/${persona.id}` && s.status !== "disconnected");
              return (
                <li className="connection" key={persona.id}>
                  <div className="source-main">
                    <h3>
                      {persona.firstName} {persona.lastName}
                    </h3>
                    <p>
                      Born {persona.dob} · {persona.address.city}, {persona.address.state}
                      <span className="tag">Sample data, not your records</span>
                    </p>
                  </div>
                  <div className="connection-actions">
                    <form action={connectMetriportSandboxAction}>
                      <input type="hidden" name="persona" value={persona.id} />
                      <button className="btn" type="submit" disabled={connectedAlready}>
                        {connectedAlready ? "Connected" : "Import records"}
                      </button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div>
        <div className="sources-head">
          <h2>Your health systems</h2>
          {sources.filter((s) => s.status === "connected").length > 1 ? (
            <form action={refreshAllAction}>
              <button className="btn btn-ghost" type="submit" disabled={sources.some((s) => s.syncing)}>
                Refresh all
              </button>
            </form>
          ) : null}
        </div>
        <SyncWatcher active={sources.some((s) => s.syncing)} />
        {sources.length === 0 ? (
          <p className="notice">Nothing connected yet.</p>
        ) : (
          <ul className="connection-list">
            {sources.map((source) => (
              <li className="connection source" key={source.id}>
                <div className="source-main">
                  <h3>{source.organizationName}</h3>
                  <p role={source.syncing ? "status" : undefined}>
                    {sourceStatus(source, now)}
                    {isSampleData(source) || isMetriportSource(source) ? <span className="tag">Sample data, not your records</span> : null}
                  </p>
                  {source.recordCount > 0 ? (
                    <ul className="source-counts" aria-label={`Records from ${source.organizationName}`}>
                      {categoryCounts(source.categoryCounts).map(({ category, label, count }) => (
                        <li key={category}>
                          <b>{count.toLocaleString("en-US")}</b> {label}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <SourceIssues source={source} />
                  {newPermissions(source, expanded).length ? (
                    <p className="source-issue">
                      Reconnect to add {listOf(newPermissions(source, expanded))}.
                    </p>
                  ) : null}
                </div>
                <div className="connection-actions">
                  {source.status === "connected" ? (
                    <form action={refreshAction}>
                      <input type="hidden" name="sourceId" value={source.id} />
                      <button className="btn btn-ghost" type="submit" disabled={source.syncing}>
                        Refresh
                      </button>
                    </form>
                  ) : null}
                  {/* Signing in again replaces the stored access and keeps the records already imported. */}
                  {source.vendor === "epic" ? (
                    <a
                      className={source.status === "connected" && !newPermissions(source, expanded).length ? "btn btn-ghost" : "btn"}
                      href={`/api/epic/authorize?${new URLSearchParams({ iss: source.fhirBaseUrl, org: source.organizationName })}`}
                    >
                      Reconnect
                    </a>
                  ) : null}
                  {source.connectionId ? (
                    <details className="source-confirm">
                      <summary className="btn btn-ghost">Disconnect</summary>
                      <div className="source-confirm-body">
                        <p>
                          We&apos;ll delete the access {source.organizationName} gave us. What should happen to the records
                          already imported?
                        </p>
                        <form action={disconnectAction}>
                          <input type="hidden" name="connectionId" value={source.connectionId} />
                          <button className="btn" type="submit">
                            Disconnect and keep records
                          </button>
                        </form>
                        <form action={deleteSourceAction}>
                          <input type="hidden" name="sourceId" value={source.id} />
                          <button className="btn btn-ghost" type="submit">
                            Disconnect and delete records
                          </button>
                        </form>
                      </div>
                    </details>
                  ) : (
                    <details className="source-confirm">
                      <summary className="btn btn-ghost">Delete records</summary>
                      <div className="source-confirm-body">
                        <p>
                          This deletes every record we imported from {source.organizationName}. Your records at the health
                          system aren&apos;t affected.
                        </p>
                        <form action={deleteSourceAction}>
                          <input type="hidden" name="sourceId" value={source.id} />
                          <button className="btn" type="submit">
                            Delete records from {source.organizationName}
                          </button>
                        </form>
                      </div>
                    </details>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h2>What we ask for</h2>
        <ul className="scope-list">
          {scopeLabels(expanded).map((item) => (
            <li key={item.scope}>{item.label}</li>
          ))}
        </ul>
        <p className="lede">
          Read-only. We import your records and keep them encrypted so your dashboard loads quickly and has your full history.
          When you disconnect, you choose whether to keep the records already imported or delete them.
          Your records at the health system are never affected.
        </p>
      </div>
    </section>
  );
}
