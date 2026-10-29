"""The public product receipt requires distinct actual views, not inflated counts."""

import copy
import unittest
import oracle_portal as r


class ProductMatrixTests(unittest.TestCase):
    def receipt(self):
        views = [
            {
                "engine": engine,
                "locale": locale,
                "width": width,
                "mode": mode,
                "robot_copy": "PASS",
                "product_navigation": "PASS",
                "horizontal_overflow": False,
            }
            for engine in ["chromium", "firefox", "webkit"]
            for locale in ["en", "de"]
            for width, mode in [(390, "dark"), (1440, "light"), (320, "light")]
        ]
        drone = [
            row
            | {
                "presentation": "PASS",
                "deferred_media": "PASS",
                "keyboard_playback": "PASS",
                "interactive_concept": "PASS",
                "platform_link": "PASS",
                "accessibility_violations": 0,
            }
            for row in views
        ]
        return {
            "status": "PASS",
            "binding": {"synthetic": "fixture"},
            "environment": "staging",
            "engines": ["chromium", "firefox", "webkit"],
            "views": views,
            "drone_views": drone,
            "operational_mutations": 0,
            "javascript_errors": 0,
            "accessibility_violations": 0,
            "speculative_prefetches": 0,
        }

    def test_duplicate_missing_or_foreign_views_cannot_inflate_acceptance(self):
        receipt = self.receipt()
        r.verify_browser_receipt(receipt, receipt["binding"], "staging")
        for field in ["views", "drone_views"]:
            for mutation in ["duplicate", "missing", "foreign"]:
                wrong = copy.deepcopy(receipt)
                if mutation == "duplicate":
                    wrong[field][0] = wrong[field][1]
                elif mutation == "missing":
                    wrong[field].pop()
                else:
                    wrong[field][0]["locale"] = "foreign"
                with (
                    self.subTest(field=field, mutation=mutation),
                    self.assertRaises(r.Refused),
                ):
                    r.verify_browser_receipt(wrong, receipt["binding"], "staging")

    def test_metadata_failures_mutations_and_skipped_interactions_remain_failures(self):
        receipt = self.receipt()
        for field, value in [
            ("status", "FAIL"),
            ("binding", {"foreign": True}),
            ("environment", "production"),
            ("operational_mutations", 1),
            ("javascript_errors", 1),
            ("accessibility_violations", 1),
            ("speculative_prefetches", 1),
        ]:
            with self.subTest(field=field), self.assertRaises(r.Refused):
                r.verify_browser_receipt(
                    receipt | {field: value}, receipt["binding"], "staging"
                )
        for field, value in [
            ("platform_link", "SKIPPED"),
            ("interactive_concept", "FAIL"),
            ("horizontal_overflow", True),
            ("keyboard_playback", "FAIL"),
        ]:
            wrong = copy.deepcopy(receipt)
            wrong["drone_views"][0][field] = value
            with self.subTest(field=field), self.assertRaises(r.Refused):
                r.verify_browser_receipt(wrong, receipt["binding"], "staging")
