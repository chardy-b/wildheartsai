const PROMISES = [
  {
    kicker: "SMART on FHIR",
    title: "You open every door",
    detail:
      "You sign in on your health system’s own page. We never see your MyChart password.",
  },
  {
    kicker: "Least access",
    title: "Only what’s needed",
    detail: "We ask only for what a feature uses, and tell you what that is.",
  },
  {
    kicker: "Your call",
    title: "Leave anytime",
    detail:
      "Disconnect any health system whenever you like. Your data isn’t for sale.",
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
      <h2 id="privacy-title">Gentle with your data, by design.</h2>
      <ol className="cards">
        {PROMISES.map((promise, i) => (
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
