// Bundled, invented sample content for the homepage demo. Not real people, clinics or records.

export const NEXT_VISIT = {
  date: "Wed, Dec 9",
  time: "10:30 AM",
  what: "Follow-up visit",
  where: "Riverside Primary Care",
};

export const FOLLOW_UP = {
  from: "Riverside Primary Care · care team",
  received: "Nov 20, 2026",
  subject: "Before your visit",
  body: "Bring your current medication list and outside lab report.",
};

export const SOURCES = [
  { id: "followup", name: "Follow-up message", from: "Riverside Primary Care", date: "Nov 20, 2026" },
  { id: "riverside", name: "Visit note", from: "Riverside Primary Care", date: "Oct 14, 2026" },
  { id: "lakeside", name: "Visit note", from: "Lakeside Gastroenterology", date: "Nov 3, 2026" },
];

export const BRIEF = {
  say: [
    { text: "The bloating and tiredness are still going on.", source: "Riverside Primary Care · Oct 14, 2026" },
    { text: "The flushing episodes have not been explained yet.", source: "Lakeside Gastroenterology · Nov 3, 2026" },
  ],
  ask: [
    { text: "Which of the open questions from both clinics should we cover first?", source: "Both visit notes" },
    { text: "Can the outside lab report be added to my record before the next visit?", source: "Follow-up · Nov 20, 2026" },
  ],
  bring: [
    { text: "Your current medication list.", source: "Follow-up · Nov 20, 2026" },
    { text: "The outside lab report.", source: "Follow-up · Nov 20, 2026" },
  ],
};

export const MEDS = [
  { id: "omeprazole", name: "Omeprazole 20 mg capsule", note: "Listed by Lakeside Gastroenterology · Nov 3, 2026" },
  { id: "cetirizine", name: "Cetirizine 10 mg tablet", note: "Listed by Riverside Primary Care · Oct 14, 2026" },
];

export const COMPARE_ROWS = [
  { topic: "Bloating", a: "Reported, ongoing", b: "Reported, ongoing" },
  { topic: "Fatigue", a: "Reported, ferritin ordered", b: "Not mentioned" },
  { topic: "Flushing", a: "Not mentioned", b: "Evaluation still open" },
];

export const LAB_SAMPLE = {
  name: "Outside lab report (sample)",
  collected: "Nov 10, 2026",
  rows: [{ test: "Ferritin", value: "18 ng/mL" }],
};

export const IMPORT_STAGES = ["Ready", "Importing", "Sample records imported"];

export const IMPORTED_SAMPLE = [
  { name: "After-visit summary (sample)", date: "Nov 18, 2026" },
  { name: "Immunization list (sample)", date: "Oct 2, 2026" },
];
