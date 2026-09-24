import { CONTACT_EMAIL, CONTACT_HREF } from "./contact";
import { FaceMark } from "./marks";

export function Closing() {
  return (
    <section className="wrap section closing" aria-labelledby="closing-title">
      <div className="moon">
        <span className="avatar">
          <FaceMark />
        </span>
        <h2 id="closing-title">Want an invite?</h2>
        <p>
          Early access is by invitation while we work closely with our first
          patients, especially people who see more than one doctor. Say hello
          and we’ll send you a code.
        </p>
        <a className="btn btn-lg" href={CONTACT_HREF}>
          Ask for an invite
        </a>
        <p className="email-safety">
          Please don’t email medical records or private health information.
        </p>
        <span className="moon-address">{CONTACT_EMAIL}</span>
      </div>
    </section>
  );
}
