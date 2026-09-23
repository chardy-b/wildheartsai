const steps = [
  {
    number: "01",
    title: "Choose your health system",
    detail: "Find a participating Epic organization and start a secure connection.",
  },
  {
    number: "02",
    title: "Authorize access",
    detail: "Sign in through your provider and choose what you want to share.",
  },
  {
    number: "03",
    title: "Bring your records together",
    detail: "Review your connected information in one patient-controlled space.",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      <header className="site-header">
        <a className="brand" href="#top" aria-label="Wild Hearts AI home">
          <span className="brand-mark" aria-hidden="true">♥</span>
          <span>Wild Hearts AI</span>
        </a>
        <span className="status-pill">In development</span>
      </header>

      <main id="main-content">
        <section className="hero" id="top">
          <div className="hero-copy">
            <p className="eyebrow">Your records. Your choice.</p>
            <h1>Health information should move with you.</h1>
            <p className="hero-lede">
              Wild Hearts AI is building a private, patient-first way to connect
              to Epic health records through standards-based FHIR authorization.
            </p>
            <div className="hero-actions">
              <a className="primary-action" href="#how-it-works">
                See how it works
              </a>
              <span className="microcopy">No health-record connection is live yet.</span>
            </div>
          </div>

          <aside className="principle-card" aria-label="Product principles">
            <p className="card-kicker">Built around you</p>
            <ul>
              <li>
                <span aria-hidden="true">01</span>
                Patient-controlled authorization
              </li>
              <li>
                <span aria-hidden="true">02</span>
                Standards-based FHIR access
              </li>
              <li>
                <span aria-hidden="true">03</span>
                Privacy before convenience
              </li>
            </ul>
          </aside>
        </section>

        <section className="steps-section" id="how-it-works" aria-labelledby="steps-title">
          <div className="section-heading">
            <p className="eyebrow">The intended experience</p>
            <h2 id="steps-title">A clear path to your own information.</h2>
          </div>
          <div className="steps-grid">
            {steps.map((step) => (
              <article className="step" key={step.number}>
                <span className="step-number">{step.number}</span>
                <h3>{step.title}</h3>
                <p>{step.detail}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="trust-section" aria-labelledby="trust-title">
          <div>
            <p className="eyebrow">A careful foundation</p>
            <h2 id="trust-title">Trust is a product requirement.</h2>
          </div>
          <p>
            The first release will use SMART on FHIR authorization, request only
            necessary permissions, and keep credentials and tokens out of the browser.
            Security and privacy claims will be documented before real patient data is used.
          </p>
        </section>
      </main>

      <footer>
        <span>© {new Date().getFullYear()} Wild Hearts AI</span>
        <span>Not medical advice · Product in development</span>
      </footer>
    </div>
  );
}
