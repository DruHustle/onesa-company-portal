"""Offline alert evaluation; never sends notifications or contacts a service."""
import argparse
import json
import re
import time
from pathlib import Path


def parse_metrics(value):
    result = {}
    for line in value.splitlines():
        if not line or line.startswith("#"):
            continue
        name, raw = line.rsplit(None, 1)
        if "{" not in name or re.fullmatch(r'[a-zA-Z_:][a-zA-Z0-9_:]*\{dependency="(?:database|model)"\}', name):
            result[name] = float(raw)
    return result


def evaluate(metrics, rules, now=None):
    now = time.time() if now is None else now
    alerts = []
    for rule in rules:
        value = metrics.get(rule["metric"])
        if value is None:
            alerts.append({"id": rule["id"], "state": "UNKNOWN"})
        else:
            measure = now - value if rule["mode"] == "age" else value
            failing = measure > rule["threshold"] if rule["operator"] == ">" else measure < rule["threshold"]
            alerts.append({"id": rule["id"], "state": "FIRING" if failing else "CLEAR"})
    return alerts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("metrics", type=Path)
    parser.add_argument("--rules", type=Path, default=Path(__file__).with_name("alert-targets.json"))
    args = parser.parse_args()
    rules = json.loads(args.rules.read_text())
    print(json.dumps({"qualification": "offline evaluation only; destination/delivery unverified", "alerts": evaluate(parse_metrics(args.metrics.read_text()), rules["rules"])}, indent=2))


if __name__ == "__main__":
    main()
