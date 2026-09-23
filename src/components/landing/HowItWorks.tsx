const STEPS = [
  {
    title: "Connect",
    detail: "Sign in to each MyChart on its own page. You choose what to share.",
  },
  {
    title: "Gather",
    detail:
      "Visits, labs, medications and notes land on one timeline, in order, without duplicates.",
  },
  {
    title: "Understand",
    detail:
      "Ask anything. Answers come from your own record and show where they came from.",
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
      <h2 id="how-title">Three rings, one&nbsp;you.</h2>
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
