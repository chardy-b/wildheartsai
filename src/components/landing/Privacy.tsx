const PRINCIPLES = [
  {
    kicker: "SMART on FHIR",
    title: "You would open every door",
    detail:
      "The planned flow keeps sign-in on your health system’s page so Wild Hearts would not receive your MyChart password.",
  },
  {
    kicker: "Least access",
    title: "Only what a feature needs",
    detail:
      "We intend to request the minimum access for each feature and explain it before you connect.",
  },
  {
    kicker: "Your call",
    title: "Revocable by design",
    detail:
      "We’re designing for disconnect controls and a business model that does not sell patient health data.",
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
      <h2 id="privacy-title">The standards we’re building toward.</h2>
      <p className="body privacy-status">
        These are design commitments for a product in development, not
        descriptions of a live record connection.
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
