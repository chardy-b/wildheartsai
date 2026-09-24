const STEPS = [
  {
    title: "Connect",
    detail:
      "You sign in on each health system’s own MyChart page and choose what to connect.",
  },
  {
    title: "Gather",
    detail:
      "Records from every health system you connect come together in one timeline, newest first.",
  },
  {
    title: "Understand",
    detail:
      "Coming next: ask about your record and see the source behind each answer.",
  },
];

export function HowItWorks() {
  return (
    <section
      className="wrap section center"
      id="how-it-works"
      aria-labelledby="how-title"
    >
      <p className="eyebrow">How it works</p>
      <h2 id="how-title">One story, three&nbsp;steps.</h2>
      <ol className="chain">
        {STEPS.map((step, i) => (
          <li className="link" key={step.title}>
            <span className="ring" aria-hidden="true">
              {i + 1}
            </span>
            <div className="step">
              <h3>{step.title}</h3>
              <p>{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
