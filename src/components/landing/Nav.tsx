import Link from "next/link";

import { HeartMark } from "./marks";

export function Nav({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <header className="wrap nav">
      <a className="brand" href="#top" aria-label="Wild Hearts Health home">
        <HeartMark />
        <span className="brand-name">Wild Hearts Health</span>
      </a>
      <nav className="nav-links" aria-label="Primary">
        <a className="nav-link" href="#how-it-works">
          How it works
        </a>
        <Link className="nav-link" href="/privacy">
          Privacy
        </Link>
        {signedIn ? (
          <span className="nav-link">Signed in</span>
        ) : (
          <Link className="nav-link" href="/sign-in">
            Sign in
          </Link>
        )}
        <Link className="btn" href={signedIn ? "/app" : "/sign-up"}>
          {signedIn ? "Dashboard" : "Get started"}
        </Link>
      </nav>
    </header>
  );
}
