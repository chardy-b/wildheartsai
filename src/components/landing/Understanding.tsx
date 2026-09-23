import { FaceMark } from "./marks";

export function Understanding() {
  return (
    <section className="wrap section split" aria-labelledby="understanding-title">
      <div>
        <p className="eyebrow">Understanding</p>
        <h2 id="understanding-title">Ask your records, not the internet.</h2>
        <p className="body">
          We’re exploring a way to ask about a result, trend or medication. A
          future version would answer from the records you connect, cite its
          sources and help you prepare questions for your care team. It would
          not diagnose you.
        </p>
      </div>
      <figure className="chat">
        <div className="panel">
          <div className="msg msg-you">
            <p className="bubble">Is my A1C getting worse?</p>
          </div>
          <div className="msg msg-companion">
            <span className="avatar">
              <FaceMark />
            </span>
            <div className="bubble">
              <p>It’s gone up a little at each check, across two clinics:</p>
              <ul className="values" aria-label="A1C results">
                <li>5.9</li>
                <li>6.0</li>
                <li>6.1</li>
              </ul>
              <p>
                That’s worth raising at your visit on Tuesday. Want me to add
                it to your questions?
              </p>
              <ul className="sources" aria-label="Sources">
                <li>Primary care · Mar 2024</li>
                <li>Endocrinology · Oct 2024</li>
                <li>Primary care · Jun 2025</li>
              </ul>
            </div>
          </div>
          <div className="replies" aria-hidden="true">
            <span className="reply">Add to questions</span>
            <span className="reply reply-alt">Open sources</span>
          </div>
        </div>
        <figcaption className="note">
          Concept mockup — not a working feature or medical advice.
        </figcaption>
      </figure>
    </section>
  );
}
