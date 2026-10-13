"""Generate independent public snapshots from the owner's approved company record."""

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "onesa-company-portal-backend/records/company-facts.v1.json"
FIELDS = {
    "legalName": "company_name", "address": "registered_address",
    "managingDirector": "managing_director", "registerCourt": "register_court",
    "registerNumber": "register_number", "email": "contact_email",
    "privacyEmail": "privacy_contact", "telephone": "telephone",
}


def publication(source=SOURCE):
    raw = source.read_bytes()
    facts = {fact["id"]: fact for fact in json.loads(raw)["facts"]}
    result = {}
    for name, key in FIELDS.items():
        fact = facts[key]
        if fact["publication_approval"] != "approved" or not fact["value"]:
            raise ValueError("Missing approved company field: " + key)
        result[name] = fact["value"]
    result["mailHref"] = "mailto:" + result["email"]
    result["telephoneHref"] = "tel:+" + "".join(c for c in result["telephone"] if c.isdigit())
    result["sourceSha256"] = hashlib.sha256(raw).hexdigest()
    return result


def outputs(workspace=False):
    company = publication()
    text = "// Generated from the owner-approved Portal company record; no runtime sibling dependency.\n"
    text += "export const company = " + json.dumps(company, ensure_ascii=False, indent=2) + " as const;\n"
    paths = [ROOT / "onesa-company-portal-frontend/src/config/company.ts", ROOT / "onesa-company-portal-backend/src/config/company.ts"]
    result = {path: text for path in paths}
    if workspace:
        result[ROOT.parent / "onesa-ai-platform/onesa-ai-platform-frontend/apps/chat/src/lib/company.ts"] = text
        robot = ROOT.parent / "onesa-ai-robot/onesa-ai-robot-frontend/public/company.json"
        result[robot] = json.dumps(company, ensure_ascii=False, indent=2) + "\n"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", action="store_true", help="Explicitly update the three approved local product snapshots")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    for path, text in outputs(args.workspace).items():
        if args.check:
            if not path.is_file() or path.read_text() != text:
                raise ValueError("Company snapshot differs: " + str(path))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
    print("Approved company snapshots " + ("verified" if args.check else "updated"))


if __name__ == "__main__":
    main()
