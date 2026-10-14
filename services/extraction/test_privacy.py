import unittest
from privacy import age_context, mask, merge, rules

class PrivacyTests(unittest.TestCase):
    def test_age_is_at_encounter_and_checks_birthday(self):
        self.assertEqual(age_context("DOB: 1980-06-20", "2025-03-01"), 44)
        self.assertEqual(age_context("DOB: 1980-06-20", "2025-06-20"), 45)
        self.assertIsNone(age_context("DOB: 1980-06-20", None))
        self.assertIsNone(age_context("DOB: 03/04/1980", "2025-03-01"))
        self.assertIsNone(age_context("DOB: 1980-06-20 DOB: 1981-06-20", "2025-03-01"))
        self.assertIsNone(age_context("DOB: 2030-06-20", "2025-03-01"))
    def test_mask_does_not_mutate_measurements_or_leave_partial_names(self):
        text = "Patient: Jane Example DOB: 1980-06-20 glucose 100 mg/dL. MRN: ABC123"
        output = mask(text, rules(text))
        self.assertNotIn("Jane", output); self.assertNotIn("1980", output); self.assertNotIn("ABC123", output)
        self.assertIn("100 mg/dL", output)
    def test_overlapping_spans_are_removed_once(self):
        spans = [{"start": 0, "end": 4, "label": "NAME"}, {"start": 0, "end": 12, "label": "NAME"}]
        self.assertEqual(mask("Jane Example lab", spans), "[REDACTED] lab")
        self.assertEqual(len(merge(spans)), 1)
    def test_unicode_offsets_are_scalar(self):
        text = "😀 Patient: Jane Example"
        output = mask(text, rules(text))
        self.assertEqual(output, "😀 Patient: [REDACTED]")

if __name__ == "__main__": unittest.main()
