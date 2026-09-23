import { CONTACT_HREF } from "./contact";
import { FigureEight } from "./FigureEight";

export function Hero() {
  return (
    <section className="wrap hero" id="top" aria-labelledby="hero-title">
      <div>
        <p className="pill">
          <span className="pill-dot" aria-hidden="true" />
          Early access for patients
        </p>
        <h1 id="hero-title">
          Every clinic, <em>gently</em> gathered into you.
        </h1>
        <p className="lede">
          Wild Hearts Health pulls your records from every MyChart you use into
          one calm timeline that belongs to you, and helps you make sense of it.
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
            <dt>1</dt>
            <dd>record, in order</dd>
          </div>
          <div>
            <dt>0</dt>
            <dd>clipboards to refill</dd>
          </div>
          <div>
            <dt>Any hour</dt>
            <dd>ask your own record</dd>
          </div>
        </dl>
      </div>
      <FigureEight />
    </section>
  );
}
