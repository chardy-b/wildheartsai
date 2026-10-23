"use client";

import { useState } from "react";
import type { DocumentBundle } from "@/lib/extraction/fhir";

export function FhirJson({ bundle }: { bundle: DocumentBundle }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState("all");
  const entries = type === "all" ? bundle.entry : bundle.entry.filter(e => e.resource.resourceType === type);
  return <section className="fhir-json"><h2>FHIR resources</h2><details onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>Inspect JSON · {bundle.entry.length} resources</summary>
    {open && <><label htmlFor="fhir-resource-type">Resource type</label> <select id="fhir-resource-type" value={type} onChange={e => setType(e.target.value)}>
      <option value="all">Complete collection Bundle</option>
      {[...new Set(bundle.entry.map(e => e.resource.resourceType))].map(t => <option key={t} value={t}>{t}</option>)}
    </select>
      <pre tabIndex={0} aria-label="FHIR JSON">{JSON.stringify(type === "all" ? bundle : entries.map(e => e.resource), null, 2)}</pre>
    </>}
  </details></section>;
}
