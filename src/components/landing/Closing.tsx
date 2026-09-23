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
          We’re speaking with patients who see more than one doctor while we
          shape this product. We’d love to hear what would help.
        </p>
        <a className="btn btn-lg" href={CONTACT_HREF}>
          Share your interest
        </a>
        <p className="email-safety">
          Please don’t email medical records or private health information.
        </p>
        <span className="moon-address">{CONTACT_EMAIL}</span>
      </div>
    </section>
  );
}
