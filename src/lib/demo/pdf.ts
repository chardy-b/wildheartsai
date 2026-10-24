// An inert, single-page PDF made only from authored synthetic text. ASCII keeps
// byte offsets deterministic and makes the provided upload fixture reproducible.
export function demoPdf(): Buffer {
  const lines = [
    "WILD HEARTS - FICTIONAL DEMO ONLY", "Outside nutrition and iron review", "Patient: Alex Morgan (invented)",
    "Sample report - page 1 of 1", "Encounter: 3 days before this demo story's reference date.", "Ferritin: 14 ng/mL. Printed reference: 15-150 ng/mL.", "Weight: 66.4 kg.",
    "Plan: bring this report to primary care for review.", "Review fatigue, dietary intake and the requested CBC.",
    "No self-directed medicine or iron changes are advised here.", "This sample supports a prepared extraction demonstration.",
    "No real patient, clinician, laboratory or institution is represented.",
  ];
  const content = `BT /F1 13 Tf 50 750 Td 22 TL ${lines.map((line, i) => `${i ? "T* " : ""}(${line.replace(/[\\()]/g, "\\$&")}) Tj`).join("\n")} ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

