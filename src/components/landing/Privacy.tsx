import Link from "next/link";

const PRINCIPLES = [
  {
    kicker: "SMART on FHIR",
    title: "You sign in through each health system",
    detail:
      "Sign-in happens on your health system’s own page, so Wild Hearts never receives your MyChart password.",
  },
  {
    kicker: "Least access",
    title: "Only what we show you",
    detail:
      "We only request the parts of your record that Wild Hearts shows you, and we keep them encrypted with a key that’s yours alone.",
  },
  {
    kicker: "Your call",
    title: "Revocable any time",
    detail:
      "Disconnect a health system whenever you like, and delete what we imported from it. We don’t sell patient health data.",
  },
];

export function Privacy() {
  return (
    <section
      className="wrap section center"
      id="privacy"
      aria-labelledby="privacy-title"
    >
      <p className="eyebrow">Privacy</p>
      <h2 id="privacy-title">The standards we hold to.</h2>
      <p className="body privacy-status">
        The details are in our <Link href="/privacy">privacy notice</Link>.
      </p>
      <ol className="cards">
        {PRINCIPLES.map((promise, i) => (
          <li className="card" key={promise.title}>
            <span className="card-number" aria-hidden="true">
              {i + 1}
            </span>
            <span className="card-kicker">{promise.kicker}</span>
            <h3>{promise.title}</h3>
            <p>{promise.detail}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
