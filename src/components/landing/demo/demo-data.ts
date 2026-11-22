// Bundled, invented sample content for the public /demo page (Alex Morgan's chart). Not real people, clinics or records.

export type VisitId = "gi" | "allergy" | "dietitian";
export type ResultId = "biopsy" | "ferritin" | "mri" | "audiology" | "allergy" | "outside" | "a1c";

export type Src = { who: string; when: string; what: string };
export type Line = { text: string; source: string };

export const DATELINE = "Alex Morgan · Sample chart · 21 Nov 2026";

export const SRC = {
  gi: { who: "Cedar Digestive Health", when: "3 Nov 2026", what: "GI follow-up: swallowing improved, bloating persists." },
  pcp: { who: "Juniper Primary Care", when: "14 Nov 2026", what: "Fatigue persists; repeat CBC and ferritin requested; confirm actual medicine use." },
  path: { who: "Cedar Digestive Health", when: "27 Jun & 27 Oct 2026", what: "Pathology: peak 42, then 8 eosinophils/hpf." },
  allergy: { who: "Harbor Allergy & Nutrition", when: "23 Aug 2026", what: "Flushing evaluation: MCAS unconfirmed; no event-timed mediator result in the chart." },
  nutrition: { who: "Harbor Allergy & Nutrition", when: "17 Sep 2026", what: "Dietitian plan: protect intake and variety while tracking symptoms." },
  ferritinOld: { who: "Juniper Primary Care", when: "25 May 2026", what: "Ferritin 22 ng/mL, range 15–150." },
  outside: { who: "Outside nutrition & iron report", when: "18 Nov 2026", what: "Page 1: ferritin 14 ng/mL, printed range 15–150." },
  imported: { who: "Sample import", when: "14 Nov 2026", what: "After-visit summary: repeat CBC and ferritin requested." },
} satisfies Record<string, Src>;

export const fmt = (s: Src) => `${s.who} · ${s.when}`;

export const VISITS: { id: VisitId; month: string; day: string; name: string; short: string; person: string; clinic: string; date: string; about: string }[] = [
  { id: "gi", month: "Nov", day: "28", name: "Gastroenterology", short: "GI", person: "Dr. Elena Park", clinic: "Cedar Digestive Health", date: "28 Nov 2026", about: "Maintenance plan & persistent bloating" },
  { id: "allergy", month: "Dec", day: "5", name: "Allergy follow-up", short: "allergy", person: "Dr. Theo Brooks", clinic: "Harbor Allergy & Nutrition", date: "5 Dec 2026", about: "Episode diary & testing strategy" },
  { id: "dietitian", month: "Dec", day: "12", name: "Dietitian follow-up", short: "dietitian", person: "Jamie Rivera, RD", clinic: "Harbor Allergy & Nutrition", date: "12 Dec 2026", about: "Intake, weight & outside report" },
];

export const visitOf = (id: string) => VISITS.find((v) => v.id === id) ?? VISITS[0];

// Named fixture target: opening other briefs must not move this question to a later visit.
export const NEXT_VISIT = visitOf("gi");

export const A1C_SAMPLES = [
  { date: "Mar 2024", value: "5.9", type: "Primary care", source: { who: "Juniper Primary Care", when: "Mar 2024", what: "Fictional primary care lab record: A1C 5.9%." } },
  { date: "Oct 2024", value: "6.0", type: "Endocrinology", source: { who: "Maple Endocrinology", when: "Oct 2024", what: "Fictional endocrinology lab record: A1C 6.0%." } },
  { date: "Jun 2025", value: "6.1", type: "Primary care", source: { who: "Juniper Primary Care", when: "Jun 2025", what: "Fictional primary care lab record: A1C 6.1%." } },
];

export const A1C_QUESTION = "My A1C went from 5.9% to 6.0% to 6.1% across two clinics. What does this trend mean, and which team should follow up?";

export const FOLLOW_UP = {
  from: "Juniper Primary Care · care team",
  received: "20 Nov 2026",
  subject: "Following up on your 14 Nov visit",
  body: "Please bring your current medicine list and any outside iron or nutrition report to your next visit. A repeat CBC and ferritin were requested; confirm timing with our team.",
};

export const RECONNECT = { name: "Connect MyChart UCSF", text: "Bring in sample records from a patient portal." };
export const IMPORT_STAGES = ["Ready", "Importing", "Imported"];
export const IMPORTED_RECORDS = [
  { name: "After-visit summary", detail: "Juniper Primary Care · 14 Nov 2026" },
  { name: "Weight 66.4 kg", detail: "Harbor Allergy & Nutrition · 17 Sep 2026" },
  { name: "Allergy list", detail: "2 entries · 23 Aug 2026" },
];

export const MEDS = [
  { id: "omeprazole", name: "Omeprazole", dose: "40 mg · twice daily", note: "Per the GI plan for EoE.", src: { who: "Cedar Digestive Health", when: "4 Jul 2026", what: "" } },
  { id: "cetirizine", name: "Cetirizine", dose: "10 mg · daily", note: "Trial for rhinitis and itching; diary shows less itching, inconsistent effect on bloating.", src: { who: "Harbor Allergy & Nutrition", when: "23 Aug 2026", what: "" } },
];

export const refillText = (m: (typeof MEDS)[number]) =>
  `Hello, I’d like to ask about a refill of ${m.name} ${m.dose.replace(" · ", ", ")} (charted ${m.src.when}). Please let me know what you need from me.`;

export const RESULTS: { id: ResultId; title: string; sub: string; modality: string }[] = [
  { id: "a1c", title: "A1C trend", sub: "Synthetic sample · Mar 2024–Jun 2025 · two clinics", modality: "Blood test" },
  { id: "biopsy", title: "Esophageal biopsies", sub: "Cedar Digestive Health · 27 Jun & 27 Oct 2026", modality: "Pathology" },
  { id: "ferritin", title: "Ferritin · earlier result", sub: "Juniper Primary Care · 25 May 2026", modality: "Blood test" },
  { id: "mri", title: "Brain MRI · report", sub: "Sample report · 10 Nov 2026", modality: "Imaging" },
  { id: "audiology", title: "Audiology · report", sub: "Sample report · 12 Nov 2026", modality: "Audiogram" },
  { id: "allergy", title: "Environmental allergy panel", sub: "Synthetic sample · 26 Aug 2026", modality: "Skin prick" },
];
export const OUTSIDE_RESULT = { id: "outside" as const, title: "Ferritin · outside report", sub: "Outside report · 18 Nov 2026 · page 1", modality: "Blood test" };

export const PATHOLOGY = [{ date: "27 Jun 2026", value: 42 }, { date: "27 Oct 2026", value: 8 }];
export const ferritinSamples = (confirmed: boolean) => [
  { date: "25 May 2026", value: 22 },
  ...(confirmed ? [{ date: "18 Nov 2026", value: 14 }] : []),
];
export const AUDIOGRAM = [
  { hz: 250, right: 10, left: 15 }, { hz: 500, right: 5, left: 10 },
  { hz: 1000, right: 5, left: 10 }, { hz: 2000, right: 10, left: 5 },
  { hz: 4000, right: 15, left: 10 }, { hz: 8000, right: 10, left: 15 },
];
export const ALLERGY_PANEL = [
  { name: "Dust mite (D. pteronyssinus)", type: "Environmental allergen", mm: 5 },
  { name: "Timothy grass", type: "Environmental allergen", mm: 4 },
  { name: "Cat dander", type: "Environmental allergen", mm: 0 },
  { name: "Histamine", type: "Positive control", mm: 6 },
  { name: "Saline", type: "Negative control", mm: 0 },
];

export const MRI_TEXT = "No acute intracranial abnormality.";
export const AUDIOLOGY_TEXT = "Hearing thresholds described as within expected range.";

export const DOC = {
  file: "outside-nutrition-iron-report.pdf",
  title: "Outside nutrition & iron review",
  patient: "Alex Morgan · 18 Nov 2026",
  rows: [
    ["Ferritin", "14 ng/mL"],
    ["Printed reference range", "15–150 ng/mL"],
    ["Weight", "66.4 kg"],
  ],
  footer: "Bring to primary care for review alongside fatigue and the requested CBC.",
  finding: { test: "Ferritin", value: "14 ng/mL", range: "15–150 ng/mL", date: "18 Nov 2026", page: "Page 1" },
};

export const SUMMARY = {
  established: [
    { text: "Biopsy-confirmed eosinophilic esophagitis (EoE).", go: { kind: "result", arg: "biopsy", label: "Biopsy trend" } },
  ],
  improving: [
    { text: "Peak eosinophils 42 → 8 per hpf; swallowing episodes less frequent. Improvement, not a claim of cure.", go: { kind: "result", arg: "biopsy", label: "Biopsy trend" } },
  ],
  uncertain: [
    { text: "Bloating, fatigue and flushing are not all explained by EoE.", go: { kind: "prep", arg: "gi", label: "GI prep" } },
    { text: "MCAS was considered and is unconfirmed; no event-timed mediator result is in the chart.", go: { kind: "prep", arg: "allergy", label: "Allergy prep" } },
  ],
  sources: [SRC.path, SRC.gi, SRC.allergy, SRC.pcp],
} as const;

export type Brief = { title: string; when: string; sub: string; say: Line[]; ask: Line[]; bring: Line[]; sources: Src[] };

type Ctx = { added: boolean; imported: boolean; a1cQuestionAdded?: boolean };

/** The visit brief for one appointment, rebuilt from session state so confirmed documents and imports show up. */
export function briefFor(id: VisitId, { added, imported, a1cQuestionAdded = false }: Ctx): Brief {
  const v = visitOf(id);
  const ci = (s: Src) => fmt(s);
  let say: Line[];
  let ask: Line[];
  let bring: Line[];
  let sources: Src[];
  if (id === "allergy") {
    say = [{ text: "“I still have intermittent flushing and GI episodes. Itching improved, but the effect on bloating has been inconsistent.”", source: ci(SRC.allergy) }];
    ask = [
      { text: "What should I record during an episode?", source: ci(SRC.allergy) },
      { text: "When and how should event-timed testing happen?", source: ci(SRC.allergy) },
      { text: "What other explanations should we consider?", source: ci(SRC.allergy) },
    ];
    bring = [
      { text: "Episode diary and relevant GI notes.", source: ci(SRC.gi) },
      { text: "Baseline tryptase 4.8 ng/mL (25 Aug 2026). MCAS is unconfirmed.", source: ci(SRC.allergy) },
    ];
    sources = [SRC.allergy, SRC.gi, SRC.pcp];
  } else if (id === "dietitian") {
    say = [{ text: "“I’m rebuilding food variety, but bloating and fatigue still make eating difficult. My latest charted weight is 66.4 kg.”", source: ci(SRC.nutrition) }];
    ask = [
      { text: "How can I protect intake without broad food restrictions?", source: ci(SRC.nutrition) },
      { text: "Would a structured diary or one supervised change help?", source: ci(SRC.nutrition) },
      { text: "How should nutrition, iron studies and fatigue follow-up be coordinated?", source: ci(SRC.pcp) },
    ];
    bring = [{ text: "Meal and symptom diary, and weight history.", source: ci(SRC.nutrition) }];
    sources = [SRC.nutrition, SRC.pcp];
  } else {
    say = [{ text: "“Food sticking is less frequent, but bloating still affects several days each week. I’d like a clear maintenance plan and help coordinating the ongoing symptoms.”", source: ci(SRC.gi) }];
    ask = [
      { text: "What is the EoE maintenance and monitoring plan?", source: ci(SRC.gi) },
      { text: "How should persistent bloating be evaluated separately?", source: ci(SRC.gi) },
      { text: "Would a supervised dietary trial help, and how would we measure it?", source: ci(SRC.nutrition) },
      { text: "Which team will coordinate fatigue and iron-study follow-up?", source: ci(SRC.pcp) },
    ];
    bring = [{ text: "Both pathology reports (42 → 8 eosinophils/hpf), symptom diary and weight history.", source: ci(SRC.path) }];
    sources = [SRC.gi, SRC.path, SRC.pcp];
  }
  bring.push({ text: "Charted medicines to confirm: omeprazole 40 mg twice daily; cetirizine 10 mg daily.", source: "Cedar · 4 Jul 2026, Harbor · 23 Aug 2026" });
  if (added) {
    ask.push({ text: "Can the outside ferritin (14 ng/mL, printed range 15–150) be reviewed with the fatigue follow-up?", source: ci(SRC.outside) });
    bring.push({ text: "Outside report, page 1: ferritin 14 ng/mL on 18 Nov 2026 (earlier chart value 22 ng/mL).", source: ci(SRC.outside) });
    sources = [...sources, SRC.outside];
  } else {
    bring.push({ text: "Outside nutrition and iron report, if available.", source: ci(SRC.pcp) });
  }
  if (imported) {
    bring.push({ text: "After-visit summary from the sample import.", source: ci(SRC.imported) });
    sources = [...sources, SRC.imported];
  }
  if (a1cQuestionAdded && id === NEXT_VISIT.id) {
    ask.push({ text: A1C_QUESTION, source: A1C_SAMPLES.map((s) => fmt(s.source)).join("; ") });
    sources = [...sources, ...A1C_SAMPLES.map((s) => s.source)];
  }
  return { title: `${v.name} brief`, when: v.date, sub: `${v.person} · ${v.clinic}`, say, ask, bring, sources };
}

export function briefText(b: Brief): string {
  const group = (label: string, lines: Line[]) => `${label}\n${lines.map((l) => `• ${l.text}`).join("\n")}`;
  return [`${b.title.toUpperCase()} · ${b.when} · ${b.sub}`, group("WHAT TO SAY", b.say), group("WHAT TO ASK", b.ask), group("WHAT TO BRING", b.bring), `SOURCES\n${b.sources.map((s) => `• ${fmt(s)}`).join("\n")}`, "Sample chart for Alex Morgan (fictional)."].join("\n\n");
}
