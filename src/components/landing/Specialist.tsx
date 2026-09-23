const SUMMARY = [
  { item: "Conditions", detail: "from 4 sources" },
  { item: "Medications", detail: "current + past" },
  { item: "Allergies", detail: "reconciled" },
  { item: "Recent results", detail: "24 months" },
  { item: "Care team", detail: "who and where" },
];

export function Specialist() {
  return (
    <section className="wrap section" aria-labelledby="specialist-title">
      <div className="statement">
        <div>
          <p className="eyebrow">For every new specialist</p>
          <h2 id="specialist-title">Stop being the fax machine.</h2>
          <p>
            Share a clean summary of your whole history, instead of re-telling
            it from the top at every first appointment.
          </p>
        </div>
        <ul className="summary" aria-label="What a summary includes">
          {SUMMARY.map(({ item, detail }) => (
            <li key={item}>
              {item}
              <span>{detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
