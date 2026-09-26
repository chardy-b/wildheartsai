import Link from "next/link";
import { labelFor } from "@/lib/fhir/categories";
import type { RecordProblem } from "@/lib/records";
import { listOf } from "@/lib/source-display";

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
            <>Importing your records from {problem.organizationName}. They&apos;ll appear here as they arrive.</>
          ) : problem.kind === "partial" ? (
            <>
              {problem.organizationName} has more {listOf(problem.categories.map((c) => labelFor(c).toLowerCase()))} than we could
              import, so some are missing.
            </>
          ) : (
            <>
              Some records from {problem.organizationName} didn&apos;t load last time we checked.{" "}
              <Link href="/app/connections">Refresh to try again</Link>
            </>
          )}
        </p>
      ))}
    </>
  );
}
