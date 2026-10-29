"""Exact signature reserve and private failure records; synthetic fixtures only."""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import oracle_portal as r
import oracle_portal_scanner as s


class SignatureReserveTests(unittest.TestCase):
    def test_two_copies_are_reserved_before_any_signature_copy(self):
        entry = SimpleNamespace(stat=lambda: SimpleNamespace(st_size=175576705))
        reserve = 12 * 1024**3
        for free, copies, passed in [
            (reserve + 175576706, 1, True),
            (reserve + 175576706, 2, False),
            (reserve + 2 * 175576705, 2, False),
            (reserve + 2 * 175576705 + 1, 2, True),
        ]:
            with (
                self.subTest(free=free, copies=copies),
                patch.object(
                    s.os,
                    "statvfs",
                    return_value=SimpleNamespace(f_bavail=free, f_frsize=1),
                ),
            ):
                if passed:
                    s.definition_reserve([entry], copies=copies)
                else:
                    with self.assertRaisesRegex(r.Refused, "SCANNER_DISK_RESERVE"):
                        s.definition_reserve([entry], copies=copies)

    def test_invalid_copy_count_and_unavailable_filesystem_never_default_to_success(
        self,
    ):
        for copies in [0, 3, True, "2"]:
            with (
                self.subTest(copies=copies),
                self.assertRaisesRegex(r.Refused, "SIGNATURE_COPY_COUNT"),
            ):
                s.definition_reserve([], copies=copies)
        with (
            patch.object(s.os, "statvfs", side_effect=OSError("synthetic")),
            self.assertRaises(OSError),
        ):
            s.definition_reserve([], copies=2)


class FailureDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.context = str(uuid4())
        self.request = {
            "binding": {
                "repository": s.REPOSITORY,
                "component": "scanner",
                "candidate_commit": "a" * 40,
            },
            "context": {"context_id": self.context},
            "password": "PRIVATE_SENTINEL",
        }
        self.enterContext(patch.object(s, "ROOT", self.root))
        self.enterContext(
            patch.object(r, "private", side_effect=lambda path, **_: Path(path))
        )

    def test_refusal_is_preserved_without_input_values_or_retry_authority(self):
        s.record_failure("staging", self.request, r.Refused("SCANNER_DISK_RESERVE"))
        files = list((self.root / "failures").glob("*.json"))
        self.assertEqual(len(files), 1)
        text = files[0].read_text()
        record = json.loads(text)
        self.assertEqual(record["failure_code"], "SCANNER_DISK_RESERVE")
        self.assertEqual(record["record_ids"], {"context_id": self.context})
        self.assertFalse(record["provider_retry_allowed"])
        self.assertTrue(record["diagnostic_only_not_authorization"])
        self.assertNotIn("PRIVATE_SENTINEL", text)

    def test_arbitrary_exception_text_is_not_recorded(self):
        s.record_failure("staging", self.request, ValueError("PRIVATE_SENTINEL"))
        text = next((self.root / "failures").glob("*.json")).read_text()
        self.assertEqual(json.loads(text)["failure_code"], "ValueError")
        self.assertNotIn("PRIVATE_SENTINEL", text)

    def test_bad_scope_and_missing_request_cannot_create_a_record(self):
        for request in [
            None,
            {},
            {
                **self.request,
                "binding": {**self.request["binding"], "component": "api"},
            },
        ]:
            s.record_failure("staging", request, ValueError("PRIVATE_SENTINEL"))
        self.assertFalse((self.root / "failures").exists())


if __name__ == "__main__":
    unittest.main()
