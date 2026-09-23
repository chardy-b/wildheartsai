import { CONTACT_HREF } from "./contact";
import { FigureEight } from "./FigureEight";

export function Hero() {
  return (
    <section className="wrap hero" id="top" aria-labelledby="hero-title">
      <div>
        <p className="pill">
          <span className="pill-dot" aria-hidden="true" />
          Product concept · patient research
        </p>
        <h1 id="hero-title">
          Every clinic, <em>gently</em> gathered into you.
        </h1>
        <p className="lede">
          Wild Hearts Health is in development. We’re designing it to bring
          records from the clinics you choose into one calm timeline and help
          you prepare for conversations with your care team.
        </p>
        <div className="actions">
          <a className="btn btn-lg" href={CONTACT_HREF}>
            Contact us
          </a>
          <a className="btn btn-lg btn-ghost" href="#how-it-works">
            How it works
          </a>
        </div>
        <dl className="proof">
          <div>
            <dt>The vision</dt>
            <dd>a patient-controlled record</dd>
          </div>
          <div>
            <dt>Designed for</dt>
            <dd>care across clinics</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>not yet connected to records</dd>
          </div>
        </dl>
      </div>
      <FigureEight />
    </section>
  );
}
