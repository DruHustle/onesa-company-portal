"""Offline negative alert fixtures, independent of providers and credentials."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("alerts", Path(__file__).with_name("operational_checks.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class OperationalChecks(unittest.TestCase):
    def test_failure_and_recovery(self):
        rules = [{"id": "db", "metric": "database", "mode": "value", "operator": "<", "threshold": 1}]
        self.assertEqual(module.evaluate({"database": 0}, rules, 100)[0]["state"], "FIRING")
        self.assertEqual(module.evaluate({"database": 1}, rules, 100)[0]["state"], "CLEAR")

    def test_absent_backup_and_missing_metric_never_pass(self):
        rules = [{"id": "backup", "metric": "backup", "mode": "age", "operator": ">", "threshold": 25*3600}]
        self.assertEqual(module.evaluate({}, rules, 100000)[0]["state"], "UNKNOWN")
        self.assertEqual(module.evaluate({"backup": 0}, rules, 100000)[0]["state"], "FIRING")

    def test_unbounded_labels_and_identity_values_are_not_republished(self):
        values = module.parse_metrics('database 1\nrequests{route="private@example.test"} 2\n')
        self.assertEqual(values, {"database": 1})


if __name__ == "__main__":
    unittest.main()
