"""Deterministic transcript/table decoding. Model output is always data, never code."""
from html.parser import HTMLParser
import re

class Transcript(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.tables = [], []
        self.table = self.row = self.cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            if self.table is not None: raise ValueError("invalid_ocr_table")
            self.table = []
        elif tag == "tr" and self.table is not None: self.row = []
        elif tag in {"td", "th"} and self.row is not None: self.cell = []
        elif tag in {"br", "p", "div"}: self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"td", "th"} and self.cell is not None:
            cell = "".join(self.cell).strip()
            if len(cell) > 4000 or len(self.row) >= 100: raise ValueError("text_limit")
            self.row.append(cell); self.cell = None; self.parts.append(" ")
        elif tag == "tr" and self.row is not None:
            if len(self.table) >= 1000: raise ValueError("text_limit")
            self.table.append(self.row); self.row = None; self.parts.append("\n")
        elif tag == "table" and self.table is not None:
            if len(self.tables) >= 100: raise ValueError("text_limit")
            self.tables.append(self.table); self.table = None; self.parts.append("\n")

    def handle_data(self, data):
        self.parts.append(data)
        if self.cell is not None: self.cell.append(data)

def transcript(raw):
    if not isinstance(raw, str) or len(raw) > 100_000: raise ValueError("text_limit")
    # Official output uses typed det blocks. Do not turn predicted block boxes
    # into word boxes or infer confidence/coverage from them.
    raw = re.sub(r"<\|det\|>\s*image\b[^<]*<\|/det\|>.*?(?=<\|det\|>|\Z)", "", raw, flags=re.S)
    raw = re.sub(r"<\|det\|>[^<]*<\|/det\|>", "\n", raw)
    raw = re.sub(r"<\|ref\|>.*?<\|/ref\|>|<PAGE>|<｜end▁of▁sentence｜>", "", raw, flags=re.S)
    parser = Transcript()
    parser.feed(raw); parser.close()
    text = re.sub(r"[ \t]+", " ", "".join(parser.parts))
    return re.sub(r"\n{3,}", "\n\n", text).strip(), parser.tables
