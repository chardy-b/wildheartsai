import type { ExtractionResult } from "./contracts";

export type ProgressItem = { fileId: string; id: string; method: string; status: string; attempts: number; nextAttemptAt: string; errorCode: string | null };
export type ProgressData = { documents: number; counts: Record<string, number>; files: ProgressItem[] };
export const statusLabel = (status: string) => ({ queued: "Queued / waiting to retry", running: "Processing", recovering: "Recovering interrupted work", completed: "Completed — review result", failed: "Failed", cancelled: "Cancelled", expired: "Expired", not_started: "Not started" })[status] ?? status;
export function extractionMethod(method: string, mime: string) {
  if (mime.startsWith("text/")) return "Direct UTF-8 text reading; OCR was not needed";
  return ({ native: "Native PDF text and tables · pdfplumber", tesseract: "Rendered-page OCR · Tesseract", rapidocr: "Offline neural OCR · RapidOCR / PP-OCRv6", docling: "Document layout extraction · Docling", vision: "Local vision-model transcription" })[method] ?? method;
}
export function coverageSummary(result: ExtractionResult) {
  return { pagesWithText: result.pages.filter(p => p.text.trim()).length, measuredPages: result.pages.filter(p => p.foregroundCoverage !== null).length, totalPages: result.totalPages };
}
export const coveragePercent = (value: number | null) => value === null ? "Not measured" : `${(value * 100).toFixed(1)}%`;
export function warningLabel(warning: string) {
  return ({ summary_input_limit_exceeded: "This document exceeded the inference input limit. Parsing was saved, but summary and measurement extraction need chunked processing.", local_summary_unavailable_or_invalid: "Local inference did not return a usable result. This older run may need to be repeated.", summary_privacy_check_failed: "The summary was withheld because it did not pass the identifier check.", age_omitted_without_unambiguous_iso_dob_and_encounter_date: "Age was omitted because an unambiguous birthdate and encounter date were not both available.", pages_without_extracted_text: "Some pages contain no extracted text. They may need OCR or another method.", measurement_candidate_rejected: "Some measurement candidates were rejected because their fields could not be matched to source evidence." })[warning] ?? warning.replaceAll("_", " ");
}
