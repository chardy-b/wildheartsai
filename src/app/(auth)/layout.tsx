import Link from "next/link";
import type { ReactNode } from "react";
import { HeartMark } from "@/components/landing/marks";
import "@/components/auth/auth.css";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <header className="wrap auth-top">
        <Link className="auth-brand" href="/" aria-label="Wild Hearts Health home">
          <HeartMark />
          Wild Hearts Health
        </Link>
      </header>
      <main className="wrap auth-main" id="main-content">
        {children}
      </main>
    </div>
  );
}
