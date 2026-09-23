import Link from "next/link";

import { CONTACT_HREF } from "./contact";
import { HeartMark } from "./marks";

export function Nav() {
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
        {/* Sign in goes here as a nav-link once login ships; Contact us stays primary. */}
        <a className="btn" href={CONTACT_HREF}>
          Share interest
        </a>
      </nav>
    </header>
  );
}
