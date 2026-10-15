import unittest
import httpx
from failures import failure_code


class FailureTests(unittest.TestCase):
    def test_unknown_messages_never_leave_worker(self):
        for stage in ("source", "parse", "privacy", "inference", "result", "completion"):
            for error in (ValueError("synthetic private text /tmp/private.pdf"), RuntimeError("provider body"), KeyError("private field")):
                self.assertEqual(failure_code(error, stage), stage + "_failed")
        self.assertEqual(failure_code(ValueError("secret"), "untrusted stage"), "processing_failed")

    def test_known_limits_have_distinct_safe_codes(self):
        self.assertEqual(failure_code(ValueError("page_limit"), "parse"), "pdf_page_limit")
        self.assertEqual(failure_code(ValueError("pixel_limit"), "parse"), "image_pixel_limit")
        self.assertEqual(failure_code(ValueError("size_limit"), "source"), "source_size_limit")
        self.assertEqual(failure_code(ValueError("result_limit"), "result"), "result_size_limit")
        self.assertEqual(failure_code(ValueError("page_limit: private text"), "parse"), "parse_failed")

    def test_timeout_and_memory_failures_are_not_error_strings(self):
        self.assertEqual(failure_code(RuntimeError("Tesseract process timeout"), "parse"), "ocr_timeout")
        self.assertEqual(failure_code(TimeoutError("private text"), "parse"), "ocr_timeout")
        self.assertEqual(failure_code(httpx.ReadTimeout("private URL"), "source"), "service_timeout")
        self.assertEqual(failure_code(MemoryError("private text"), "parse"), "resource_limit")


if __name__ == "__main__": unittest.main()
