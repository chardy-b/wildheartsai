import { CONTACT_EMAIL, CONTACT_HREF } from "./contact";
import { FaceMark } from "./marks";

export function Closing() {
  return (
    <section className="wrap section closing" aria-labelledby="closing-title">
      <div className="moon">
        <span className="avatar">
          <FaceMark />
        </span>
        <h2 id="closing-title">Say hello.</h2>
        <p>
          We’re opening early access to a small group of patients who see more
          than one doctor. We’d love to hear from you.
        </p>
        <a className="btn btn-lg" href={CONTACT_HREF}>
          Contact us
        </a>
        <span className="moon-address">{CONTACT_EMAIL}</span>
      </div>
    </section>
  );
}
