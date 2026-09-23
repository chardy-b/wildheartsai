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
