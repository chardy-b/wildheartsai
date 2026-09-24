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
