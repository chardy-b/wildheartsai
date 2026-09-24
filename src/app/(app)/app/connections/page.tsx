import type { Metadata } from "next";
import { OrgSearch } from "@/components/app/OrgSearch";
import { db } from "@/lib/db";
import { SCOPE_LABELS } from "@/lib/epic/authorize";
import { listConnections } from "@/lib/epic/connections";
import { isSampleData, loadConnectable, organizationChoices } from "@/lib/epic/directory";
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

  const [connections, connectable] = await Promise.all([
    listConnections(db, session.user.id),
    loadConnectable(environment).catch(() => null),
  ]);
  const connectedUrls = new Set(connections.map((c) => c.fhirBaseUrl));
  const { results, sample } = organizationChoices(environment, connectable ?? [], connectedUrls, query);
  const errorMessage = connectErrorMessage(error) ?? (connectable ? undefined : connectErrorMessage("unavailable"));

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
                  <p>
                    Connected {dateFormat.format(connection.connectedAt)}
                    {isSampleData(connection) ? <span className="tag">Sample data, not your records</span> : null}
                  </p>
                </div>
                <div className="connection-actions">
                  {/* Signing in again replaces the stored access for this health system. */}
                  <a className="btn btn-ghost" href={`/api/epic/authorize?iss=${encodeURIComponent(connection.fhirBaseUrl)}`}>
                    Reconnect
                  </a>
                  <form action={disconnectAction}>
                    <input type="hidden" name="connectionId" value={connection.id} />
                    <button className="btn btn-ghost" type="submit">
                      Disconnect
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel-light">
        <h2>Add a health system</h2>
        <OrgSearch environment={environment} query={query} results={results} sample={sample} formAction="/app/connections" />
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
