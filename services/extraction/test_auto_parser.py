import unittest
from unittest.mock import Mock, patch
import auto_parser


def page(n, text, ink=1000):
    return {"page": n, "text": text, "words": [], "tables": [], "figures": [], "diagnostics": {"foregroundPixels": ink}}


class AutoParserTests(unittest.TestCase):
    def test_native_text_and_blank_pages_do_not_run_ocr(self):
        for pages in ([page(1, "Synthetic native content with enough characters")], [page(1, "", 0)]):
            with patch.object(auto_parser, "parse", return_value=pages) as parse:
                self.assertEqual(auto_parser.parse_auto(None, "application/pdf", Mock(), Mock()), pages)
                self.assertEqual(parse.call_count, 1)

    def test_only_sparse_pages_run_ocr_and_native_attempt_is_retained(self):
        native = [page(1, "Synthetic native content with enough characters"), page(2, "Header")]
        native[1]["tables"] = [[["Synthetic", "table"]]]
        native[1]["figures"] = [{"box": [0, 0, 1, 1], "caption": "", "origin": "unknown"}]
        with patch.object(auto_parser, "parse", side_effect=[native, [page(2, "Synthetic OCR transcript")]]) as parse:
            result = auto_parser.parse_auto(None, "application/pdf", Mock(), Mock())
            self.assertEqual(parse.call_args.kwargs["page_numbers"], {2})
            self.assertEqual(result[0], native[0])
            self.assertEqual(result[1]["nativeAttempt"]["text"], "Header")
            self.assertEqual(result[1]["text"], "Synthetic OCR transcript")
            self.assertEqual(result[1]["tables"], native[1]["tables"])

    def test_native_engine_failure_falls_back_without_exposing_error(self):
        with patch.object(auto_parser, "parse", side_effect=[RuntimeError("synthetic private detail"), [page(1, "OCR")]]):
            result = auto_parser.parse_auto(None, "application/pdf", Mock(), Mock())
            self.assertEqual(result[0]["nativeAttempt"]["status"], "failed")
            self.assertNotIn("private", str(result))

    def test_limits_and_outages_do_not_trigger_redundant_ocr(self):
        class Outage(Exception): pass
        for error in (ValueError("page_limit"), MemoryError(), Outage()):
            with patch.object(auto_parser, "parse", side_effect=error) as parse:
                with self.assertRaises(type(error)):
                    auto_parser.parse_auto(None, "application/pdf", Mock(), Mock(), (Outage,))
                self.assertEqual(parse.call_count, 1)

    def test_plain_text_bypasses_ocr(self):
        with patch.object(auto_parser, "parse", return_value=[page(1, "Short")]) as parse:
            auto_parser.parse_auto(None, "text/plain", Mock(), Mock())
            self.assertEqual(parse.call_count, 1)

    def test_mixed_scan_with_native_header_is_routed_by_coverage(self):
        mixed = page(1, "Synthetic native header " * 5)
        mixed["figures"] = [{"box": [0, 0, 1, 1], "caption": "", "origin": "unknown"}]
        mixed["foregroundCoverage"] = .1
        self.assertTrue(auto_parser.needs_ocr(mixed))
        mixed["foregroundCoverage"] = .9
        self.assertFalse(auto_parser.needs_ocr(mixed))


if __name__ == "__main__": unittest.main()
