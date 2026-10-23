import type { ExtractionResult } from "./contracts";

export type ProgressItem = { fileId: string; id: string; method: string; status: string; attempts: number; nextAttemptAt: string; errorCode: string | null };
export type ProgressData = { documents: number; counts: Record<string, number>; files: ProgressItem[]; durablePending?: number };
export const statusLabel = (status: string) => ({ waiting: "Waiting for batch admission", queued: "Queued / waiting to retry", running: "Processing", recovering: "Recovering interrupted work", completed: "Completed — review result", failed: "Failed", cancelled: "Cancelled", expired: "Expired", not_started: "Not started" })[status] ?? status;
export function extractionMethod(method: string, mime: string, pipeline?: string) {
  if (mime.startsWith("text/")) return "Direct UTF-8 text reading; OCR was not needed";
  if (pipeline === "native-ocr/v1") return "Native PDF parsing first; selective Tesseract OCR fallback · per-page attempts retained";
  return ({ native: "Native PDF text and tables · pdfplumber", tesseract: "Rendered-page OCR · Tesseract", rapidocr: "Offline neural OCR · RapidOCR / PP-OCRv6", docling: "Document layout extraction · Docling", vision: "Local vision-model transcription", unlimitedocr: "Local document OCR · Baidu Unlimited OCR (experimental)" })[method] ?? method;
}
export function coverageSummary(result: ExtractionResult) {
  return { pagesWithText: result.pages.filter(p => p.text.trim()).length, measuredPages: result.pages.filter(p => p.foregroundCoverage !== null).length, totalPages: result.totalPages };
}
export const coveragePercent = (value: number | null) => value === null ? "Not measured" : `${(value * 100).toFixed(1)}%`;
export function warningLabel(warning: string) {
  const chunkWarnings: Record<string,string> = {
    summary_partial_input: "Some summary input chunks were not processed. The document-level summary was withheld; parsing remains available.",
    measurement_partial_input: "Only part of this document reached quantitative extraction. The saved measurements may be incomplete.",
    inference_time_budget_exceeded: "Local inference reached its time budget. Parsing was saved and incomplete inference is flagged.",
    no_text_for_inference: "No extracted text was available. A summary and quantitative results were not generated.",
    summary_privacy_or_format_check_failed: "A summary failed the identifier or format check and was withheld.",
    local_measurements_unavailable_or_invalid: "A quantitative extraction chunk did not return valid structured output. Measurements may be incomplete.",
    measurement_output_limit_exceeded: "The quantitative candidate limit was reached. Measurements may be incomplete.",
  };
  if (chunkWarnings[warning]) return chunkWarnings[warning];
  return ({ summary_input_limit_exceeded: "This document exceeded the inference input limit. Parsing was saved, but summary and measurement extraction need chunked processing.", local_summary_unavailable_or_invalid: "Local inference did not return a usable result. This older run may need to be repeated.", summary_privacy_check_failed: "The summary was withheld because it did not pass the identifier check.", age_omitted_without_unambiguous_iso_dob_and_encounter_date: "Age was omitted because an unambiguous birthdate and encounter date were not both available.", pages_without_extracted_text: "Some pages contain no extracted text. They may need OCR or another method.", measurement_candidate_rejected: "Some measurement candidates were rejected because their fields could not be matched to source evidence." })[warning] ?? warning.replaceAll("_", " ");
}
