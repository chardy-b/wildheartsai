import Link from "next/link";

import { CONTACT_EMAIL, CONTACT_HREF } from "./contact";
import { FaceMark } from "./marks";

export function Closing({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <section className="wrap section closing" aria-labelledby="closing-title">
      <div className="moon">
        <span className="avatar">
          <FaceMark />
        </span>
        <h2 id="closing-title">{signedIn ? "Welcome back." : "Want an invite?"}</h2>
        {signedIn ? (
          <>
            <p>You’re signed in. Open your dashboard to see your records and connections.</p>
            <Link className="btn btn-lg" href="/app">Go to dashboard</Link>
          </>
        ) : (
          <>
            <p>
              Early access is by invitation while we work closely with our first
              patients, especially people who see more than one doctor. Say hello
              and we’ll send you a code.
            </p>
            <a className="btn btn-lg" href={CONTACT_HREF}>Ask for an invite</a>
            <p className="email-safety">
              Please don’t email medical records or private health information.
            </p>
            <span className="moon-address">{CONTACT_EMAIL}</span>
          </>
        )}
      </div>
    </section>
  );
}
