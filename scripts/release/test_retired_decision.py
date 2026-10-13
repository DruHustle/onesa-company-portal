"""Editable or malformed legacy approval files never authorize a release."""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import qualify


class RetiredDecisionTests(unittest.TestCase):
    def test_forged_pass_and_matching_source_hash_cannot_authorize_release(self):
        for contents in [
            json.dumps(
                {
                    **{gate: "PASS" for gate in qualify.GATES},
                    "valid_for_source_sha256": "forged",
                }
            ),
            "invalid approval data",
        ]:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                path = root / "docs/internal/release-audit/evidence/gates.json"
                path.parent.mkdir(parents=True)
                path.write_text(contents)
                output = io.StringIO()
                with (
                    patch.object(qualify, "ROOT", root),
                    patch.object(
                        qualify, "source_hash", return_value="forged"
                    ) as fingerprint,
                    patch.object(sys, "argv", ["qualify.py", "decision"]),
                    contextlib.redirect_stdout(output),
                    self.assertRaises(SystemExit) as caught,
                ):
                    qualify.main()
                self.assertEqual(caught.exception.code, 1)
                self.assertIn("NO-GO", output.getvalue())
                self.assertNotIn("PASS", output.getvalue())
                self.assertNotIn("invalid approval data", output.getvalue())
                fingerprint.assert_not_called()


if __name__ == "__main__":
    unittest.main()
