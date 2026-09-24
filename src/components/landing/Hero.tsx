import Link from "next/link";

import { FigureEight } from "./FigureEight";

export function Hero() {
  return (
    <section className="wrap hero" id="top" aria-labelledby="hero-title">
      <div>
        <p className="pill">
          <span className="pill-dot" aria-hidden="true" />
          Early access · by invitation
        </p>
        <h1 id="hero-title">
          Your care is scattered. Your <em>story</em> shouldn’t be.
        </h1>
        <p className="lede">
          Wild Hearts Health gathers the records you choose into one clear
          timeline—so you can see the whole story and prepare for every
          appointment.
        </p>
        <div className="actions">
          <Link className="btn btn-lg" href="/sign-up">
            Get started
          </Link>
          <a className="btn btn-lg btn-ghost" href="#how-it-works">
            How it works
          </a>
        </div>
        <dl className="proof">
          <div>
            <dt>What it is</dt>
            <dd>a patient-controlled record</dd>
          </div>
          <div>
            <dt>Designed for</dt>
            <dd>care across clinics</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>early access, by invitation</dd>
          </div>
        </dl>
      </div>
      <FigureEight />
    </section>
  );
}
