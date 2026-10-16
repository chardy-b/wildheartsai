"""Finite public failure codes. Never serialize exceptions or document context."""
import httpx

STAGES = {"source", "parse", "privacy", "inference", "result", "completion"}
LIMITS = {
    "size_limit": "source_size_limit",
    "page_limit": "pdf_page_limit",
    "pixel_limit": "image_pixel_limit",
    "text_limit": "text_limit",
    "result_limit": "result_size_limit",
}


def bounded_processing_retry(code, attempt):
    return attempt < 3 and code not in {
        "source_size_limit", "pdf_page_limit", "image_pixel_limit", "text_limit",
        "result_size_limit", "resource_limit",
    }


def failure_code(error, stage):
    if stage not in STAGES:
        return "processing_failed"
    if isinstance(error, MemoryError):
        return "resource_limit"
    # Only exact, internally defined sentinel values qualify. Unknown messages
    # (including filenames or provider response bodies) never leave the worker.
    value = error.args[0] if error.args else None
    if isinstance(error, ValueError) and isinstance(value, str) and value in LIMITS:
        return LIMITS[value]
    if stage == "parse" and (
        isinstance(error, TimeoutError)
        or isinstance(error, RuntimeError) and isinstance(value, str) and value == "Tesseract process timeout"
    ):
        return "ocr_timeout"
    if isinstance(error, httpx.TimeoutException):
        return "service_timeout"
    return stage + "_failed"
