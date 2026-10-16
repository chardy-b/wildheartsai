"""Native-first parsing with retained native evidence and selective local OCR."""
from parsers import parse
from failures import failure_code

POLICY = "native-ocr/v1"


def needs_ocr(page):
    diagnostics = page.get("diagnostics", {})
    # Blank pages do not need OCR. Short text on an ink-bearing page can be a
    # scanned report with only a native header; this is a routing heuristic.
    size = len(page["text"].strip())
    return bool(diagnostics.get("scanLike")) or (
        diagnostics.get("foregroundPixels", 0) > 50
        and (size == 0 or size < 32 and bool(page.get("figures")))
    ) or (
        bool(page.get("figures")) and size < 300
        and page.get("foregroundCoverage") is not None and page["foregroundCoverage"] < .35
    )


def attempt(page, status="completed"):
    return {"status": status, "text": page.get("text", ""),
            "words": page.get("words", []), "tables": page.get("tables", []),
            "figures": page.get("figures", [])}


def parse_auto(source, mime, infer, check_active, service_errors=()):
    try:
        native = parse(source, mime, "native", infer, check_active)
    except Exception as error:
        if isinstance(error, service_errors):
            raise
        if failure_code(error, "parse") in {"pdf_page_limit", "image_pixel_limit", "text_limit", "resource_limit"}:
            raise
        # No exception message or document path enters the result.
        pages = parse(source, mime, "tesseract", infer, check_active)
        for page in pages:
            page["nativeAttempt"] = attempt({}, "failed")
            page["fallbackReason"] = "native_parser_failed"
        return pages
    wanted = {p["page"] for p in native if needs_ocr(p)} if not mime.startswith("text/") else set()
    if not wanted:
        return native
    ocr = {p["page"]: p for p in parse(source, mime, "tesseract", infer, check_active, page_numbers=wanted)}
    pages = []
    for page in native:
        if page["page"] in wanted:
            selected = ocr[page["page"]]
            selected["nativeAttempt"] = attempt(page)
            selected["fallbackReason"] = "scan_like_or_sparse_native_text"
            # Preserve native table/image geometry alongside the OCR transcript.
            selected["tables"] = page["tables"] or selected["tables"]
            selected["figures"] = page["figures"] or selected["figures"]
            pages.append(selected)
        else:
            pages.append(page)
    return pages
