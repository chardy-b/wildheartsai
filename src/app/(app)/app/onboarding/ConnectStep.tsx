import { FinishLater } from "@/components/app/FinishLater";
import { OrgSearch } from "@/components/app/OrgSearch";
import { loadDirectory, searchOrganizations } from "@/lib/epic/directory";
import { env } from "@/lib/env";
import "@/components/app/connections.css";

export async function ConnectStep({ query, error }: { query: string; error?: string }) {
  const environment = env().EPIC_ENVIRONMENT;
  const directory = await loadDirectory(environment).catch(() => []);
  const results = environment === "sandbox" || query ? searchOrganizations(directory, query) : [];
  return (
    <div className="auth-form">
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <OrgSearch environment={environment} query={query} results={results} formAction="/app/onboarding" />
      <FinishLater />
    </div>
  );
}
