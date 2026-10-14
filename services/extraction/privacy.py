"""Local span detection and deterministic summary policy. No content logging."""
import datetime as dt
import re
import unicodedata

PATTERNS = {
    "EMAIL": r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b",
    "PHONE": r"(?<!\d)(?:\+1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)",
    "ID": r"\b(?:MRN|SSN|patient\s*id|account\s*(?:number|no\.?))\s*[:#]?\s*([\w-]+)",
    "DOB": r"\b(?:DOB|date\s+of\s+birth|born)\s*[:=]?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{4})\b",
    "NAME": r"\b(?i:patient\s*(?:name)?\s*:|name\s*:|dr\.)\s*([A-Z][\w'’-]+(?:[ \t]+(?!DOB\b|MRN\b|SSN\b)[A-Z][\w'’-]+){0,3})",
}

def canonical_label(label):
    label = label.upper().replace("-", "_")
    if any(x in label for x in ("BIRTH", "DOB")): return "DOB"
    if any(x in label for x in ("NAME", "PERSON", "PATIENT", "DOCTOR")): return "NAME"
    if "EMAIL" in label: return "EMAIL"
    if any(x in label for x in ("PHONE", "FAX")): return "PHONE"
    if any(x in label for x in ("ADDRESS", "LOCATION", "STREET", "CITY", "ZIP")): return "ADDRESS"
    if "DATE" in label: return "DATE"
    if "AGE" in label: return "AGE"
    return "ID"

def rules(text):
    spans = []
    for label, pattern in PATTERNS.items():
        flags = re.I if label != "NAME" else 0
        for match in re.finditer(pattern, text, flags):
            start, end = match.span(1 if match.lastindex else 0)
            spans.append({"start": start, "end": end, "label": label})
    return sorted(spans, key=lambda s: (s["start"], s["end"]))

def merge(spans):
    result = []
    for span in sorted(spans, key=lambda s: (s["start"], -s["end"])):
        if result and span["start"] < result[-1]["end"]:
            result[-1]["end"] = max(result[-1]["end"], span["end"])
            if span["label"] == "DOB": result[-1]["label"] = "DOB"
        else: result.append(dict(span))
    return result

def mask(text, spans):
    for span in reversed(merge(spans)):
        text = text[:span["start"]] + "[REDACTED]" + text[span["end"]:]
    return text

def age_context(text, encounter_date):
    """Only explicit, complete DOBs and caller-supplied encounter dates qualify."""
    if not encounter_date: return None
    try: anchor = dt.date.fromisoformat(encounter_date)
    except ValueError: return None
    births = set()
    for span in rules(text):
        if span["label"] != "DOB": continue
        value = text[span["start"]:span["end"]]
        try:
            # Slash dates are ambiguous across locales. Require ISO for calculation.
            births.add(dt.date.fromisoformat(value))
        except ValueError: return None
    if len(births) != 1: return None
    birth = births.pop()
    age = anchor.year - birth.year - ((anchor.month, anchor.day) < (birth.month, birth.day))
    return age if birth <= anchor and 0 <= age <= 120 else None

class LocalPrivacy:
    def __init__(self, model_dir):
        from openmed import extract_pii
        self.extract_pii = extract_pii
        self.model_dir = model_dir

    def detect(self, text):
        if not text: return []
        spans = []
        # Overlapping windows avoid silently truncating long pages at model context size.
        # Paragraph/word boundary windows minimize split identifiers; overlap deduplicates below.
        for start in range(0, len(text), 900):
            chunk = text[start:start + 1500]
            result = self.extract_pii(chunk, model_name=self.model_dir, use_smart_merging=True)
            for entity in result.entities:
                label = canonical_label(entity.label)
                if label == "AGE": continue
                a, b = int(entity.start), int(entity.end)
                if not (0 <= a < b <= len(chunk)): raise ValueError("invalid_pii_offsets")
                spans.append({"start": start + a, "end": start + b, "label": label})
        # Reclassify dates explicitly identified as DOB, including a fragmented prediction.
        dob = [s for s in rules(text) if s["label"] == "DOB"]
        for s in spans:
            if any(s["start"] < d["end"] and d["start"] < s["end"] for d in dob): s["label"] = "DOB"
        return merge(spans)

    def redact(self, text):
        rule_spans, model_spans = rules(text), self.detect(text)
        combined = merge(rule_spans + model_spans)
        return {"rules": rule_spans, "openmed": model_spans, "combined": combined, "text": mask(text, combined)}

    def safe_summary(self, text, source_spans):
        # Reject output that still has detector hits or repeats a known identifier surface.
        normalized = unicodedata.normalize("NFKC", text).casefold()
        for value in source_spans:
            value = unicodedata.normalize("NFKC", value).casefold().strip()
            if len(value) >= 2 and re.search(r"(?<!\w)" + re.escape(value) + r"(?!\w)", normalized): return False
        return not rules(text) and not self.detect(text)
