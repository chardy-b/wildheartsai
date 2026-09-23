import type { ReactNode } from "react";
import { FaceMark } from "@/components/landing/marks";

export function AuthCard({ title, lede, children }: { title: string; lede?: string; children: ReactNode }) {
  return (
    <section className="auth-card" aria-labelledby="auth-title">
      <span className="avatar">
        <FaceMark />
      </span>
      <h1 id="auth-title">{title}</h1>
      {lede ? <p className="auth-lede">{lede}</p> : null}
      {children}
    </section>
  );
}
