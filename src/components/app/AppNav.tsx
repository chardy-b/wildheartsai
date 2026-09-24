import Link from "next/link";
import { HeartMark } from "@/components/landing/marks";
import { SignOutButton } from "./SignOutButton";

export type NavLink = { href: string; label: string };

export function AppNav({ links }: { links: NavLink[] }) {
  return (
    <header className="wrap app-nav">
      <Link className="app-brand" href="/app" aria-label="Wild Hearts Health dashboard">
        <HeartMark />
        Wild Hearts Health
      </Link>
      <nav className="app-nav-links" aria-label="Dashboard">
        {links.map((link) => (
          <Link key={link.href} href={link.href}>
            {link.label}
          </Link>
        ))}
        <SignOutButton />
      </nav>
    </header>
  );
}
