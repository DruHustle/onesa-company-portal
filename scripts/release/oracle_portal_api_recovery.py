"""Explicit owner commissioning and read-only recovery of one existing API intent.

No source qualification, authorization or deployment is created or transferred.
The original signed chain and provider command remain immutable. Install this
reviewed source outside Actions through the existing owner SSH/sudo mechanism
before commissioning. Merely copying a file or supplying JSON grants no trust.
"""

import argparse
import base64
import datetime as dt
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

sys.path[:0] = [
    str(Path(__file__).resolve().parent.parent),
    str(Path(__file__).resolve().parent),
]
import oracle_install as installer
import oracle_owner as owner
import oracle_portal_api as api

PEER_STORES = Path("/var/lib/onesa/release-verification")
PEER_PINS = {
    "robot": "ce023133291cda61ddbc483ccdb46df5e8735bf71c32701e2074c95b5fdcf575",
    "ai": "7d4eb927bde7af6872372b4298a058ee21adb6577260878fa2a82b3b5a25db66",
    "portal-scanner": "8e1bb7fe738a65e25ce5d8ed95621f9c9f8a788dd6aecb9e9b37c440dbacbf66",
}
PEER_REPOSITORIES = {
    "robot": "DruHustle/onesa-robot",
    "ai": "DruHustle/onesa-ai-platform",
    "portal-scanner": "DruHustle/onesa-company-portal",
}
PEER_TARGETS = {
    ("DruHustle/onesa-robot", "api"): {
        "staging": "onesa-robot-oracle-api-staging-1",
        "production": "onesa-robot-oracle-api-production-1",
    },
    ("DruHustle/onesa-ai-platform", "api"): {
        "staging": "onesa-ai-oracle-api-staging-1",
        "production": "onesa-ai-oracle-api-production-1",
    },
    ("DruHustle/onesa-company-portal", "scanner"): {
        # This legacy name serves the production consumer; its name is not
        # evidence of isolation. Only an accepted production record may match.
        "production": "onesa-portal-oracle-staging-scanner-1",
    },
}
for _feature in ["twins-api", "cybersecurity-api"]:
    PEER_TARGETS[("DruHustle/onesa-ai-platform", _feature)] = PEER_TARGETS[
        ("DruHustle/onesa-ai-platform", "api")
    ]


def peer_store(store, path):
    """Load only an existing externally commissioned, independently pinned issuer."""
    path = Path(path)
    match = re.fullmatch(r"(robot|ai|portal-scanner)-owner-([a-f0-9]{40})", path.name)
    owner.require(
        path.parent == PEER_STORES and match, "REGISTERED_PEER_STORE_REQUIRED"
    )
    owner.private(path, directory=True)
    owner.private(path / "trust.json")
    owner.private(owner.ANCHOR)
    trust = json.loads((path / "trust.json").read_bytes())
    registry = json.loads(Path(owner.ANCHOR).read_bytes())
    anchor = registry["installations"].get(str(path), {})
    owner.require(
        anchor.get("active") is True
        and all(
            anchor.get(k) == trust[k]
            for k in ["installation_id", "key_id", "verifier_sha256", "policy_sha256"]
        ),
        "PEER_COMMISSION_REQUIRED",
    )
    core = installer.INSTALL_PARENT / (match[1] + "-" + match[2]) / "oracle_owner.py"
    owner.private(core)
    owner.require(
        owner.file_digest(core) == trust["verifier_sha256"] == PEER_PINS[match[1]],
        "INDEPENDENT_PEER_VERIFIER_PIN_REQUIRED",
    )
    spec = importlib.util.spec_from_file_location(
        "commissioned_independent_owner", core
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Both issuers consult the same external owner-controlled registry.
    module.ANCHOR = owner.ANCHOR
    peer = module.Store(path, module.GitHub(store.github.token))
    peer.expected_repository = PEER_REPOSITORIES[match[1]]
    return peer


def independent_receipts(store, references):
    """Recognize existing releases, never authorize or alter another component.

    A staging qualification proves its actual isolated container; production
    additionally requires the existing accepted deployment and verification chain.
    Historical inspection does not renew either release or its one-use context.
    """
    owner.require(
        isinstance(references, list) and len(references) <= 5,
        "BOUNDED_INDEPENDENT_RECEIPTS_REQUIRED",
    )
    actual = api.r.inventory() if references else {}
    expected, provenance = {}, []
    for reference in references:
        owner.require(
            isinstance(reference, dict)
            and set(reference) == {"store", "record", "environment"}
            and reference["environment"] in {"staging", "production"}
            and isinstance(reference["record"], str)
            and re.fullmatch(r"[a-f0-9-]{36}", reference["record"]),
            "EXACT_INDEPENDENT_RECEIPT_REFERENCE_REQUIRED",
        )
        peer = peer_store(store, reference["store"])
        try:
            environment = reference["environment"]
            kind = (
                "qualification"
                if environment == "staging"
                else "production-verification"
            )
            record = signed_unrevoked(peer, reference["record"], kind)["record"]
            binding = record["binding"]
            owner.require(
                binding["repository"] == peer.expected_repository,
                "INDEPENDENT_ISSUER_REPOSITORY_MISMATCH",
            )
            targets = PEER_TARGETS.get((binding["repository"], binding["component"]))
            owner.require(
                targets is not None
                and environment in targets
                and binding["target_environment"] == "production",
                "INDEPENDENT_COMPONENT_SCOPE_REQUIRED",
            )
            name = targets[environment]
            owner.require(
                name not in expected and name in actual,
                "EXACT_UNIQUE_PEER_RUNTIME_REQUIRED",
            )
            # The peer issuer verifies its own repository-bound signed chain;
            # this Portal issuer must not reinterpret it as a Portal binding.
            profile = peer.policy["components"].get(
                binding["repository"] + ":" + binding["component"]
            )
            owner.require(profile is not None, "INDEPENDENT_PEER_POLICY_SCOPE_REQUIRED")
            if environment == "staging":
                observation = record["details"]["staging"]["observations"]
                for phase in ["staging", "operations"]:
                    checks = record["details"][phase]["observations"]["checks"]
                    owner.require(
                        all(
                            checks.get(k) == "PASS"
                            for k in profile["required_checks"][phase]
                        ),
                        "COMPLETE_INDEPENDENT_QUALIFICATION_REQUIRED",
                    )
            else:
                intent = signed_unrevoked(
                    peer, record["parent"], "deployment-intent", binding
                )["record"]
                state = peer.db.execute(
                    "SELECT state FROM deployments WHERE id=?", (intent["id"],)
                ).fetchone()
                owner.require(
                    state and state[0] == "accepted",
                    "ACCEPTED_INDEPENDENT_PRODUCTION_REQUIRED",
                )
                observation = record["details"]["observations"]
                owner.require(
                    all(
                        observation["checks"].get(k) == "PASS"
                        for k in profile["required_checks"]["production"]
                    ),
                    "COMPLETE_PEER_PRODUCTION_REQUIRED",
                )
            runtime = api.r.summary(actual[name])
            labels = actual[name]["Config"].get("Labels", {})
            owner.require(
                api.r.healthy(actual[name])
                and observation["binding"] == binding
                and observation["environment"] == environment
                and observation["workflow_run_id"] == 0
                and observation["deployment_id"] == runtime["container_id"]
                and runtime["source"] == binding["candidate_commit"]
                and runtime["image"] == binding["artifact_digest"]
                and labels.get("org.onesa.source-archive-sha256")
                == binding["source_sha256"],
                "ACTUAL_INDEPENDENT_IDENTITY_REQUIRED",
            )
            owner.require(
                observation.get("actual_runtime") == runtime,
                "SIGNED_COMPLETE_INDEPENDENT_RUNTIME_REQUIRED",
            )
            if binding["repository"] == "DruHustle/onesa-robot":
                owner.require(
                    observation.get("physical_hardware_authorized") is False,
                    "INDEPENDENT_SOFTWARE_SCOPE_REQUIRED",
                )
            expected[name] = runtime
            provenance.append(
                {
                    "store": str(peer.root),
                    "record": record["id"],
                    "kind": kind,
                    "environment": environment,
                    "key_id": peer.trust["key_id"],
                    "record_sha256": owner.digest(record),
                    "runtime": name,
                }
            )
        finally:
            peer.db.close()
    return expected, provenance


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


def commission(store, operation, source, root, independent=None):
    owner.require(
        os.geteuid() == 0
        and os.getenv("SUDO_USER") == "ubuntu"
        and not os.getenv("GITHUB_ACTIONS")
        and store.github.owner() == owner.OWNER,
        "EXPLICIT_EXTERNAL_ROOT_OWNER_COMMISSION_REQUIRED",
    )
    pins, ci = reviewed_source(store.github, source, root)
    references = [] if independent is None else independent
    baselines, provenance = independent_receipts(store, references)
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
                "independent_receipt_references": references,
                "independent_runtime_baselines": baselines,
                "independent_receipt_provenance": provenance,
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
        independent, provenance = independent_receipts(
            store, details.get("independent_receipt_references", [])
        )
        owner.require(
            independent == details.get("independent_runtime_baselines", {})
            and provenance == details.get("independent_receipt_provenance", []),
            "COMMISSIONED_INDEPENDENT_RECEIPTS_CHANGED",
        )
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
            **({"independent": independent} if independent else {}),
        )
        owner.require(
            independent_receipts(
                store, details.get("independent_receipt_references", [])
            )
            == (independent, provenance),
            "INDEPENDENT_RUNTIME_CHANGED_DURING_OBSERVATION",
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
                "independent_receipt_provenance": provenance,
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
    p.add_argument("--independent-receipts", type=Path)
    args = p.parse_args()
    owner.require(
        os.geteuid() == 0
        and os.getenv("SUDO_USER") == "ubuntu"
        and not os.getenv("GITHUB_ACTIONS"),
        "EXTERNAL_ROOT_OWNER_ONLY",
    )
    request = json.load(sys.stdin)
    owner.require(
        args.action == "commission" or args.independent_receipts is None,
        "RECONCILIATION_REQUIRES_EXPLICIT_COMMISSION",
    )
    references = None
    if args.independent_receipts is not None:
        # References contain IDs only; they cannot supply observations or PASS.
        owner.private(args.independent_receipts)
        references = json.loads(args.independent_receipts.read_bytes())
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
            commission(store, args.record, request["observer_source"], root, references)
            if args.action == "commission"
            else observe(store, args.record, root)
        )
        print(json.dumps(result))
    finally:
        store.db.close()


if __name__ == "__main__":
    main()
