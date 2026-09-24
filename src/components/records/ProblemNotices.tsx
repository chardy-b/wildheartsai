import Link from "next/link";
import type { RecordProblem } from "@/lib/records";

export function ProblemNotices({ problems }: { problems: RecordProblem[] }) {
  return (
    <>
      {problems.map((problem) => (
        <p className="problem" role="status" key={problem.organizationName}>
          {problem.kind === "reconnect" ? (
            <>
              {problem.organizationName} needs you to sign in again. <Link href="/app/connections">Reconnect</Link>
            </>
          ) : (
            <>We couldn&apos;t reach {problem.organizationName} just now, so some records may be missing.</>
          )}
        </p>
      ))}
    </>
  );
}
