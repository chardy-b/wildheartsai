// This allowlist is shared at the worker HTTP boundary and the persistence
// boundary. It must never accept exception messages, paths, or document values.
export const FAILURE_CODES = [
  "processing_failed", "source_failed", "parse_failed", "privacy_failed",
  "inference_failed", "result_failed", "completion_failed", "source_size_limit",
  "pdf_page_limit", "image_pixel_limit", "text_limit", "result_size_limit",
  "resource_limit", "ocr_timeout", "service_timeout",
] as const;

export type FailureCode = typeof FAILURE_CODES[number];

export function publicFailureCode(value: unknown): FailureCode {
  return typeof value === "string" && (FAILURE_CODES as readonly string[]).includes(value)
    ? value as FailureCode : "processing_failed";
}
