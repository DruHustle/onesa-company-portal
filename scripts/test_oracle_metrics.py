"""Run the actual metrics CLI with disposable modules; no provider or database access."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts/oracle_metrics.mjs"
ROW = {"failed_jobs": 2, "queue_age_seconds": 12.5, "deletion_age_seconds": -120}


class OracleMetricsClientTests(unittest.TestCase):
    def run_client(self, *, database=None, scanner=None, args=()):
        with tempfile.TemporaryDirectory(prefix="onesa-metrics-cli-") as directory:
            root = Path(directory)
            (root / "metrics.mjs").write_bytes(SCRIPT.read_bytes())
            (root / "package.json").write_text('{"type":"module"}')
            modules = root / "dist/src/services"
            modules.mkdir(parents=True)
            (modules / "db.js").write_text(database or (
                "export const db={query:async()=>({rows:[" + json.dumps(ROW)
                + "]}),end:async()=>{}};"
            ))
            (modules / "storage.js").write_text(scanner or (
                "export async function scannerStatusCurrent(){return true;}"
            ))
            result = subprocess.run(
                ["node", str(root / "metrics.mjs"), *args],
                cwd=root, capture_output=True, timeout=5, check=False,
                env={"PATH": os.environ["PATH"]},
            )
            self.assertNotIn(b"private-provider-detail", result.stdout + result.stderr)
            return result, (root / "database-imported").exists()

    def test_success_preserves_future_scheduled_deletion_age(self):
        result, _ = self.run_client()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {
            "scanner_ready": True, "database_available": True, **ROW,
        })

    def test_database_query_import_and_cleanup_failure_do_not_erase_scanner(self):
        for source, available in (
            ("export const db={query:async()=>{throw Error('private-provider-detail');},end:async()=>{}};", False),
            ("throw Error('private-provider-detail');", False),
            ("export const db={query:async()=>({rows:[" + json.dumps(ROW)
             + "]}),end:async()=>{throw Error('private-provider-detail');}};", True),
            ("export const db={query:async()=>{throw Error('private-provider-detail');},"
             "end:async()=>{throw Error('private-provider-detail');}};", False),
        ):
            with self.subTest(database_available=available, source=source[:24]):
                result, _ = self.run_client(database=source)
                self.assertEqual(result.returncode, 0)
                value = json.loads(result.stdout)
                self.assertTrue(value["scanner_ready"])
                self.assertEqual(value["database_available"], available)
                self.assertEqual(set(value), {"scanner_ready", "database_available"}
                                 | (set(ROW) if available else set()))

    def test_scanner_failure_does_not_erase_database_aggregates(self):
        for source in (
            "export async function scannerStatusCurrent(){return false;}",
            "export async function scannerStatusCurrent(){throw Error('private-provider-detail');}",
            "throw Error('private-provider-detail');",
            "export async function scannerStatusCurrent(){return 'true';}",
        ):
            with self.subTest(source=source[:40]):
                result, _ = self.run_client(scanner=source)
                self.assertEqual(result.returncode, 0)
                self.assertEqual(json.loads(result.stdout), {
                    "scanner_ready": False, "database_available": True, **ROW,
                })

    def test_scanner_only_never_imports_database_module(self):
        source = (
            "import{writeFileSync}from'node:fs';"
            "writeFileSync('database-imported','unexpected');"
            "throw Error('private-provider-detail');"
        )
        for ready in (False, True):
            with self.subTest(ready=ready):
                result, imported = self.run_client(
                    database=source,
                    scanner="export async function scannerStatusCurrent(){return "
                    + json.dumps(ready) + ";}", args=("--scanner-only",),
                )
                self.assertEqual(result.returncode, 0)
                self.assertFalse(imported)
                self.assertEqual(json.loads(result.stdout), {"scanner_ready": ready})

    def test_unknown_modes_are_rejected_before_imports(self):
        for args in (("--database-only",), ("--scanner-only", "--scanner-only"), ("secret",)):
            with self.subTest(args=args):
                result, _ = self.run_client(database="throw Error('private-provider-detail');",
                                            scanner="throw Error('private-provider-detail');", args=args)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(result.stderr, b"Invalid metrics mode\n")

    def test_aggregate_types_and_projection_are_strict(self):
        rows = [
            {**ROW, "failed_jobs": True}, {**ROW, "failed_jobs": -1},
            {**ROW, "failed_jobs": 1.5}, {**ROW, "failed_jobs": 2**53},
            {**ROW, "queue_age_seconds": "12"},
            {**ROW, "deletion_age_seconds": False},
            {**ROW, "queue_age_seconds": float("inf")},
            {**ROW, "deletion_age_seconds": float("nan")},
        ]
        for row in rows:
            with self.subTest(row=row):
                source = "export const db={query:async()=>({rows:[" + json.dumps(row) + "]}),end:async()=>{}};"
                result, _ = self.run_client(database=source)
                self.assertEqual(result.returncode, 0)
                self.assertEqual(json.loads(result.stdout), {
                    "scanner_ready": True, "database_available": False,
                })
        source = "export const db={query:async()=>({rows:[" + json.dumps({
            **ROW, "provider_detail": "private-provider-detail",
        }) + "]}),end:async()=>{}};"
        result, _ = self.run_client(database=source)
        self.assertEqual(json.loads(result.stdout), {
            "scanner_ready": True, "database_available": True, **ROW,
        })


if __name__ == "__main__":
    unittest.main()
