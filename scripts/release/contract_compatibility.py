"""Conservative pre-audit compatibility gate, separate from generated-file drift."""
import argparse
import copy
import json

from schema_compatibility import request_compatible, response_compatible, schema_subset
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def resolve(spec, value, property_names=False):
    if isinstance(value, dict):
        if "$ref" in value:
            target = spec
            for part in value["$ref"].removeprefix("#/").split("/"):
                target = target[part]
            return resolve(spec, target)
        return {k: resolve(spec, v, k == "properties") for k, v in value.items() if property_names or k not in {"title", "description", "example", "examples", "summary"}}
    if isinstance(value, list):
        return [resolve(spec, item) for item in value]
    return value

def compare(old, new):
    failures = []
    for path, methods in old["paths"].items():
        for method, operation in methods.items():
            if method not in {"get", "post", "patch", "put", "delete", "head", "options"}:
                continue
            current = new.get("paths", {}).get(path, {}).get(method)
            label = method.upper() + " " + path
            if current is None:
                failures.append(label + ": removed operation")
                continue
            for key in ("requestBody", "parameters", "responses", "security"):
                before = resolve(old, operation.get(key))
                after = resolve(new, current.get(key))
                if before != after and not ((key == "responses" and response_compatible(before, after)) or (key == "requestBody" and request_compatible(before, after))):
                    failures.append(label + ": " + key + " changed; explicit compatibility review required")
    return failures

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    spec_path = ROOT / 'onesa-company-portal-backend/openapi/openapi.json'
    baseline = json.loads((ROOT / "docs/api/release-baseline.json").read_text())
    if args.self_test:
        assert not compare(baseline, baseline)
        assert schema_subset({"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"], "additionalProperties": False}, {"type": "object", "additionalProperties": True})
        assert not schema_subset({"type": "object", "properties": {}, "additionalProperties": False}, {"type": "object", "required": ["title"], "properties": {"title": {"type": "string"}}})
        assert not schema_subset({"type": "string"}, {"type": "integer"})
        assert not schema_subset({"type": "object", "properties": {"private": {}}, "additionalProperties": False}, {"type": "object", "additionalProperties": False})
        assert not schema_subset({"type": "string"}, {"type": "string", "enum": ["allowed"]})
        assert resolve({}, {"properties": {"title": {"type": "string"}}})["properties"]["title"] == {"type": "string"}
        broken = copy.deepcopy(baseline)
        path = next(iter(broken["paths"]))
        del broken["paths"][path]
        assert compare(baseline, broken)
        print("Unchanged baseline accepted; deliberate removed-route fixture rejected")
        return
    failures = compare(baseline, json.loads(spec_path.read_text()))
    for failure in failures:
        print(failure)
    print("Compatibility review findings:", len(failures))
    if failures:
        raise SystemExit(1)

if __name__ == "__main__":
    main()
