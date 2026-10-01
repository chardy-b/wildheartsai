import { FinishLater } from "@/components/app/FinishLater";
import { OrgSearch } from "@/components/app/OrgSearch";
import { db } from "@/lib/db";
import { connectChoices } from "@/lib/epic/directory-store";
import { enabledEpicEnvironment, env } from "@/lib/env";
import "@/components/app/connections.css";

export async function ConnectStep({ query, error }: { query: string; error?: string }) {
  const environment = enabledEpicEnvironment(env());
  const { results, sample } = await connectChoices(db, environment, query, new Set()).catch(() => ({
    results: [],
    sample: null,
  }));
  return (
    <div className="auth-form">
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <OrgSearch environment={environment} query={query} results={results} sample={sample} formAction="/app/onboarding" />
      <FinishLater />
    </div>
  );
}
