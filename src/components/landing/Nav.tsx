import { CONTACT_HREF } from "./contact";
import { HeartMark } from "./marks";

export function Nav() {
  return (
    <header className="wrap nav">
      <a className="brand" href="#top" aria-label="Wild Hearts Health home">
        <HeartMark />
        Wild Hearts Health
      </a>
      <nav className="nav-links" aria-label="Primary">
        <a className="nav-link" href="#how-it-works">
          How it works
        </a>
        <a className="nav-link" href="#privacy">
          Privacy
        </a>
        {/* Sign in goes here as a nav-link once login ships; Contact us stays primary. */}
        <a className="btn" href={CONTACT_HREF}>
          Contact us
        </a>
      </nav>
    </header>
  );
}
