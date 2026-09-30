import type { Organization } from "@/lib/epic/directory";

// A clinic connects under its health system's name; `org` picks which of an address's listed
// names that is (the authorize route only accepts a listed one).
function connectHref(org: Organization): string {
  const params = new URLSearchParams({ iss: org.fhirBaseUrl, org: org.partOf ?? org.name });
  return `/api/epic/authorize?${params}`;
}

function details(org: Organization): string | null {
  const parts = [
    org.partOf ? `Part of ${org.partOf}` : null,
    org.location ?? null,
    org.otherNames?.length ? `Also listed as ${org.otherNames.join(", ")}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function ConnectList({ organizations, label }: { organizations: Organization[]; label: string }) {
  return (
    <ul className="org-results">
      {organizations.map((org) => {
        const more = details(org);
        return (
          <li key={org.fhirBaseUrl}>
            <span>
              {org.name}
              {more ? <small className="org-aka">{more}</small> : null}
            </span>
            <a className="btn" href={connectHref(org)}>
              {label}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function OrgSearch({
  environment,
  query,
  results,
  sample,
  formAction,
}: {
  environment: "sandbox" | "production";
  query: string;
  results: Organization[];
  sample: Organization | null;
  formAction: string;
}) {
  return (
    <div className="org-search">
      {environment === "production" ? (
        <>
          <form className="org-search-form" action={formAction} method="get" role="search">
            <label className="field">
              Find your health system
              <input name="q" type="search" defaultValue={query} placeholder="Hospital, clinic or practice name" />
            </label>
            <button className="btn" type="submit">
              Search
            </button>
          </form>
          <p className="org-note">
            Search for where you use MyChart, or for the hospital or clinic you visited. You&apos;ll sign in to MyChart to
            approve the connection.
          </p>
        </>
      ) : (
        <p className="org-note">
          Early access uses Epic&apos;s test environment. Sign in with one of Epic&apos;s sample MyChart patients.
        </p>
      )}
      {results.length > 0 ? (
        <ConnectList organizations={results} label="Connect" />
      ) : query ? (
        <p className="org-note">
          No health systems match “{query}”. Try one word from its name. Only health systems that offer MyChart
          through Epic are listed, so some aren&apos;t here yet.
        </p>
      ) : null}
      {sample ? (
        <div className="org-sample">
          <p className="org-note">
            <strong>Just looking?</strong> Try a sample patient from Epic&apos;s test system instead. Its records are made
            up. Epic provides the current sample-patient sign-in details on its test MyChart page.
          </p>
          <ConnectList organizations={[sample]} label="Try sample data" />
        </div>
      ) : null}
    </div>
  );
}
