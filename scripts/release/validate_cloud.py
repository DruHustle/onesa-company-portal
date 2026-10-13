"""Offline configuration gate using the recorded official provider schema."""

import hashlib
import json
from pathlib import Path

import jsonschema
import yaml

ROOT = Path(__file__).resolve().parents[2]
FOLDER = Path(__file__).resolve().parent
schema = FOLDER / "render.schema.json"
provenance = json.loads((FOLDER / "render.schema.provenance.json").read_text())
assert hashlib.sha256(schema.read_bytes()).hexdigest() == provenance["sha256"]
blueprint = yaml.safe_load((ROOT / "render.yaml").read_text())
jsonschema.validate(blueprint, json.loads(schema.read_text()))
for service in blueprint["services"]:
    assert service["branch"] == "main"
    assert service["autoDeployTrigger"] == "off"
    assert (ROOT / service["rootDir"] / service["dockerfilePath"]).is_file()
assert not blueprint.get("databases"), (
    "Use the existing Neon project; never create a duplicate database"
)
assert len(blueprint["services"]) == 1 and blueprint["services"][0]["type"] == "web"
assert all(service["plan"] == "free" for service in blueprint["services"])
api = blueprint["services"][0]
api_env = {entry["key"]: entry for entry in api["envVars"]}
assert api_env["SESSION_KEY"].get("sync") is False, (
    "Preserve the existing private encryption key"
)
assert not any(
    "generateValue" in entry or "fromService" in entry for entry in api["envVars"]
), "Preserve existing credentials; Oracle receives scoped values privately"

front = ROOT / (
    "onesa-ai-platform-frontend/apps/chat"
    if ROOT.name == "onesa-ai-platform"
    else "onesa-company-portal-frontend"
)
vercel = json.loads((front / "vercel.json").read_text())
deployments = vercel["git"]["deploymentEnabled"]
assert deployments is False or deployments == {
    "main": False,
    "dev": False,
    "staging": True,
}, "Native production/dev deployments must remain disabled"
print(
    "PASS: official Blueprint schema, independent Docker contexts, main, manual Free API deployment and no duplicate database/worker"
)
print(
    "BLOCKED: hosted domains, credentials, migrations, model/storage/email/scanner and acceptance must be verified separately"
)
