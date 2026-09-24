import type { Organization } from "@/lib/epic/directory";

function ConnectList({ organizations, label }: { organizations: Organization[]; label: string }) {
  return (
    <ul className="org-results">
      {organizations.map((org) => (
        <li key={org.fhirBaseUrl}>
          <span>{org.name}</span>
          <a className="btn" href={`/api/epic/authorize?iss=${encodeURIComponent(org.fhirBaseUrl)}`}>
            {label}
          </a>
        </li>
      ))}
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
              <input name="q" type="search" defaultValue={query} placeholder="Hospital or clinic name" />
            </label>
            <button className="btn" type="submit">
              Search
            </button>
          </form>
          <p className="org-note">Search for where you use MyChart. You&apos;ll sign in to MyChart to approve the connection.</p>
        </>
      ) : (
        <p className="org-note">
          Early access uses Epic&apos;s test environment. Sign in with one of Epic&apos;s sample MyChart patients.
        </p>
      )}
      {results.length > 0 ? (
        <ConnectList organizations={results} label="Connect" />
      ) : query ? (
        <p className="org-note">No health systems match “{query}”. Try a shorter name.</p>
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
