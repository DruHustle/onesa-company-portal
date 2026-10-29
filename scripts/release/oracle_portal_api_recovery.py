"""Explicit owner commissioning and read-only recovery of one existing API intent.

No source qualification, authorization or deployment is created or transferred.
The original signed chain and provider command remain immutable. Install this
reviewed source outside Actions through the existing owner SSH/sudo mechanism
before commissioning. Merely copying a file or supplying JSON grants no trust.
"""

import argparse
import base64
import datetime as dt
import json
import os
import sys
from pathlib import Path

sys.path[:0] = [
    str(Path(__file__).resolve().parent.parent),
    str(Path(__file__).resolve().parent),
]
import oracle_install as installer
import oracle_owner as owner
import oracle_portal_api as api


def signed_unrevoked(store, identity, kind=None, binding=None):
    result = store.get(identity, kind, binding, historical=True)
    pending = [result["record"]]
    visited = set()
    while pending:
        record = pending.pop()
        if record["id"] in visited:
            continue
        visited.add(record["id"])
        owner.require(len(visited) <= 12, "BOUNDED_HISTORICAL_CHAIN_REQUIRED")
        row = store.db.execute(
            "SELECT revoked FROM records WHERE id=?", (record["id"],)
        ).fetchone()
        owner.require(row and row[0] == 0, "HISTORICAL_REVOCATION_REFUSED")
        parents = [record["parent"]] if record["parent"] else []
        if record["kind"] == "authorization":
            parents.append(record["details"]["attempt_id"])
        pending.extend(
            store.get(parent, binding=result["record"]["binding"], historical=True)[
                "record"
            ]
            for parent in parents
        )
    return result


def original(store, operation):
    intent = signed_unrevoked(store, operation, "deployment-intent")["record"]
    binding = intent["binding"]
    owner.require(
        binding["repository"] == "DruHustle/onesa-company-portal"
        and binding["component"] == "api"
        and binding["target_environment"] == "production"
        and intent["details"]["provider_request_budget"] == 1
        and intent["details"]["automatic_retry"] is False,
        "EXACT_EXISTING_API_INTENT_REQUIRED",
    )
    authorization = store.get(
        intent["parent"], "authorization", binding, historical=True
    )["record"]
    qualification = store.get(
        authorization["parent"], "qualification", binding, historical=True
    )["record"]
    profile = owner.binding_valid(binding, store.policy)
    for phase in ["staging", "operations"]:
        checks = qualification["details"][phase]["observations"]["checks"]
        owner.require(
            all(checks.get(key) == "PASS" for key in profile["required_checks"][phase]),
            "ORIGINAL_MANDATORY_QUALIFICATION_REQUIRED",
        )
    return intent


def installed_files(root):
    owner.private(root, directory=True)
    owner.require(
        root.parent == installer.INSTALL_PARENT
        and root.name.startswith("portal-api-observer-"),
        "EXTERNAL_OWNER_INSTALLED_OBSERVER_REQUIRED",
    )
    result = {}
    for local in installer.API_ALLOWED:
        file = root / local
        owner.private(file)
        result[local] = owner.file_digest(file)
    return result


def reviewed_source(github, source, root):
    owner.require(
        set(source) == {"repository", "candidate_commit", "source_tree"}
        and source["repository"] == "DruHustle/onesa-company-portal"
        and root.name == "portal-api-observer-" + source["source_tree"],
        "OBSERVER_SOURCE_SCOPE_REQUIRED",
    )
    ci = github.qualify(source)
    owner.require(ci, "CURRENT_MAIN_OBSERVER_CI_REQUIRED")
    tree = github.api(
        "repos/"
        + source["repository"]
        + "/git/trees/"
        + source["source_tree"]
        + "?recursive=1"
    )
    owner.require(not tree.get("truncated"), "COMPLETE_OBSERVER_SOURCE_REQUIRED")
    blobs = {row["path"]: row for row in tree["tree"] if row["type"] == "blob"}
    pins = installed_files(root)
    for local, upstream in installer.API_ALLOWED.items():
        blob = blobs.get(upstream)
        owner.require(
            blob and blob["mode"] == "100644", "REVIEWED_OBSERVER_FILE_REQUIRED"
        )
        observed = github.api(
            "repos/" + source["repository"] + "/git/blobs/" + blob["sha"]
        )
        owner.require(
            observed["encoding"] == "base64"
            and base64.b64decode(observed["content"], validate=False)
            == (root / local).read_bytes(),
            "OBSERVER_DIFFERS_FROM_REVIEWED_MAIN",
        )
    return pins, ci


def commission(store, operation, source, root):
    owner.require(
        os.geteuid() == 0
        and os.getenv("SUDO_USER") == "ubuntu"
        and not os.getenv("GITHUB_ACTIONS")
        and store.github.owner() == owner.OWNER,
        "EXPLICIT_EXTERNAL_ROOT_OWNER_COMMISSION_REQUIRED",
    )
    pins, ci = reviewed_source(store.github, source, root)
    owner.require(
        owner.file_digest(root / "oracle_owner.py") == store.trust["verifier_sha256"],
        "HISTORICAL_ISSUER_IMPLEMENTATION_MUST_REMAIN_PINNED",
    )
    with store.transaction():
        intent = original(store, operation)
        state = store.db.execute(
            "SELECT state FROM deployments WHERE id=?", (operation,)
        ).fetchone()
        owner.require(
            state and state[0] in {"request-recorded", "deployed-unverified"},
            "UNRESOLVED_EXISTING_OPERATION_REQUIRED",
        )
        return store.put(
            "production-observer-commission",
            intent["binding"],
            {
                "operation_id": operation,
                "observer_source": source,
                "installed_root": str(root),
                "file_pins": pins,
                "ci": ci,
                "purpose": "read-only-observer-defect-correction",
                "deployment_requests": 0,
                "qualification_reissued": False,
                "authorization_reissued": False,
            },
            parent=operation,
        )


def observe(store, commission_id, root):
    envelope = signed_unrevoked(store, commission_id, "production-observer-commission")
    record = envelope["record"]
    details = record["details"]
    operation = details["operation_id"]
    owner.require(
        dt.datetime.fromisoformat(record["issued_at"])
        <= store.clock()
        < dt.datetime.fromisoformat(record["expires_at"]),
        "FRESH_OBSERVER_COMMISSION_REQUIRED",
    )
    owner.require(
        record["parent"] == operation
        and details["installed_root"] == str(root)
        and details["purpose"] == "read-only-observer-defect-correction"
        and details["deployment_requests"] == 0
        and details["qualification_reissued"] is False
        and details["authorization_reissued"] is False,
        "EXPLICIT_OPERATION_SCOPED_COMMISSION_REQUIRED",
    )
    owner.require(
        installed_files(root) == details["file_pins"], "COMMISSIONED_OBSERVER_CHANGED"
    )
    # The installation's code and original issuer remain separately pinned.
    owner.require(
        owner.file_digest(root / "oracle_owner.py") == store.trust["verifier_sha256"],
        "HISTORICAL_ISSUER_CHANGED",
    )
    with api.component_lock(), store.transaction():
        owner.require(
            signed_unrevoked(store, commission_id, "production-observer-commission")
            == envelope
            and store.clock() < dt.datetime.fromisoformat(record["expires_at"])
            and installed_files(root) == details["file_pins"],
            "OBSERVER_COMMISSION_CHANGED_OR_EXPIRED_WHILE_WAITING",
        )
        intent = original(store, operation)
        owner.require(
            intent["binding"] == record["binding"], "OBSERVER_SOURCE_TRANSFER_REFUSED"
        )
        state = store.db.execute(
            "SELECT state FROM deployments WHERE id=?", (operation,)
        ).fetchone()
        owner.require(state, "DURABLE_OPERATION_REQUIRED")
        if state[0] == "accepted":
            return {
                "operation_id": operation,
                "state": "accepted",
                "provider_write": False,
                "duplicate_observation": False,
            }
        owner.require(
            state[0] in {"request-recorded", "deployed-unverified"},
            "OPERATION_STATE_REFUSED",
        )
        target = api.deployment_folder(operation)
        provider = api.r.read(target / "provider-command-result.json")
        owner.require(
            provider == {"returncode": 0, "automatic_retry": False},
            "SUCCESSFUL_ORIGINAL_PROVIDER_COMMAND_REQUIRED",
        )
        tool = root / "runners" / api.PRODUCTION_TOOL
        actual = api.runner(
            "production",
            intent["binding"],
            {"operation_id": operation, "read_only": True},
            observer_tool=(
                tool,
                details["file_pins"]["runners/" + api.PRODUCTION_TOOL],
            ),
        )
        profile = owner.binding_valid(intent["binding"], store.policy)
        owner.require(
            actual["binding"] == intent["binding"]
            and actual["environment"] == "production"
            and actual["workflow_run_id"] == 0
            and actual["operation_id"] == operation
            and actual.get("deployment_id")
            and all(
                actual["checks"].get(key) == "PASS"
                for key in profile["required_checks"]["production"]
            )
            and dt.timedelta(0)
            <= store.clock() - dt.datetime.fromisoformat(actual["observed_at"])
            < dt.timedelta(minutes=5),
            "FRESH_COMPLETE_ACTUAL_PRODUCTION_REQUIRED",
        )
        receipts = store.db.execute(
            "SELECT id FROM records WHERE kind='deployment-receipt' AND parent=?",
            (operation,),
        ).fetchall()
        if receipts:
            receipt = signed_unrevoked(
                store, receipts[-1][0], "deployment-receipt", intent["binding"]
            )["record"]
            owner.require(
                receipt["details"]["observations"]["deployment_id"]
                == actual["deployment_id"],
                "ORIGINAL_PROVIDER_RECEIPT_IDENTITY_CHANGED",
            )
        result = store.put(
            "production-verification",
            intent["binding"],
            {
                "runner_sha256": details["file_pins"]["runners/oracle_portal_api.py"],
                "observer_commission": commission_id,
                "observer_source": details["observer_source"],
                "observations": actual,
                "provider_request_repeated": False,
            },
            parent=operation,
        )
        store.db.execute(
            "UPDATE deployments SET state='accepted' WHERE id=?", (operation,)
        )
        return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("action", choices=["commission", "observe"])
    p.add_argument("--store", type=Path, required=True)
    p.add_argument("--record", required=True)
    args = p.parse_args()
    owner.require(
        os.geteuid() == 0
        and os.getenv("SUDO_USER") == "ubuntu"
        and not os.getenv("GITHUB_ACTIONS"),
        "EXTERNAL_ROOT_OWNER_ONLY",
    )
    request = json.load(sys.stdin)
    owner.require(
        set(request)
        == (
            {"owner_token", "observer_source"}
            if args.action == "commission"
            else {"owner_token"}
        ),
        "NO_CALLER_OBSERVATIONS_ACCEPTED",
    )
    root = Path(__file__).resolve().parent.parent
    store = owner.Store(args.store, owner.GitHub(request["owner_token"]))
    try:
        result = (
            commission(store, args.record, request["observer_source"], root)
            if args.action == "commission"
            else observe(store, args.record, root)
        )
        print(json.dumps(result))
    finally:
        store.db.close()


if __name__ == "__main__":
    main()
