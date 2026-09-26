import Link from "next/link";
import { labelFor } from "@/lib/fhir/categories";
import type { RecordProblem } from "@/lib/records";

function list(words: string[]): string {
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function ProblemNotices({ problems }: { problems: RecordProblem[] }) {
  return (
    <>
      {problems.map((problem) => (
        <p className="problem" role="status" key={`${problem.organizationName}-${problem.kind}`}>
          {problem.kind === "reconnect" ? (
            <>
              {problem.organizationName} needs you to sign in again. <Link href="/app/connections">Reconnect</Link>
            </>
          ) : problem.kind === "importing" ? (
            <>Importing your records from {problem.organizationName}. Refresh this page in a minute to see more.</>
          ) : problem.kind === "partial" ? (
            <>
              {problem.organizationName} has more {list(problem.categories.map((c) => labelFor(c).toLowerCase()))} than we could
              import, so some are missing.
            </>
          ) : (
            <>We couldn&apos;t reach {problem.organizationName} just now, so some records may be missing.</>
          )}
        </p>
      ))}
    </>
  );
}
