import { FinishLater } from "@/components/app/FinishLater";
import { OrgSearch } from "@/components/app/OrgSearch";
import { backend } from "@/lib/backend";
import "@/components/app/connections.css";

export async function ConnectStep({ query, error }: { query: string; error?: string }) {
  const { settings, choices } = await (await backend()).connectChoices(query);
  const { results, sample } = choices ?? { results: [], sample: null };
  return (
    <div className="auth-form">
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <OrgSearch environment={settings.environment} query={query} results={results} sample={sample} formAction="/app/onboarding" />
      <FinishLater />
    </div>
  );
}
