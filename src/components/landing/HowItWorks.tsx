const STEPS = [
  {
    title: "Connect",
    detail:
      "The planned flow sends you to each health system’s own sign-in page. You would choose what to connect.",
  },
  {
    title: "Gather",
    detail:
      "With your permission, supported records would be organized into one timeline.",
  },
  {
    title: "Understand",
    detail:
      "The goal is to answer from your connected record and show the source behind each response.",
  },
];

export function HowItWorks() {
  return (
    <section
      className="wrap section center"
      id="how-it-works"
      aria-labelledby="how-title"
    >
      <p className="eyebrow">How we plan for it to work</p>
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
