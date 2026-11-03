"""Independent signed, hosted acceptance after each product's qualified rollout.

The account backend can be qualified before the independent product deployments.
This component then binds their genuinely signed accepted revisions to actual
Docker/Vercel readbacks and runs the cross-product browser suite exactly once.
No nested release, provider configuration or deployment is permitted here.
"""

import base64
import datetime as dt
import json
import os
import re
import sqlite3
import sys
import urllib.parse
import urllib.request
from pathlib import Path

_runners = Path(__file__).resolve().parent
# The owner verifier is installed one directory above the reviewed runners.
# Python's isolated mode omits both directories from its default import path.
sys.path.insert(0, str(_runners.parent))
sys.path.insert(0, str(_runners))
import oracle_owner as owner
import oracle_portal as r
import oracle_portal_identity as identity

PROFILE = "portal-shared-identity-acceptance-v1"
PLAN = Path("/etc/onesa/oracle-portal-identity-acceptance.json")
ROOT = Path("/var/lib/onesa/release-verification/portal/identity-acceptance")
REPOSITORIES = {
    "portal": "DruHustle/onesa-company-portal",
    "ai": "DruHustle/onesa-ai-platform",
    "drone": "DruHustle/onesa-drone",
    "robot": "DruHustle/onesa-robot",
}
COMPONENTS = {
    "portal": {"identity"},
    "ai": {"api", "identity-api"},
    "drone": {"backend", "backend-identity"},
    "robot": {"api", "api-identity"},
}
CHECKS = {phase: set(values) for phase, values in owner.REQUIRED_CHECKS.items()}
CURRENT = "accepted-current-exact-binding"
for phase in CHECKS:
    CHECKS[phase] |= {"independent_product_acceptance", "exact_served_revisions"}


def configuration(plan, env):
    return {
        "component": "identity-acceptance",
        "environment": env,
        **{k: v for k, v in plan.items() if k != "verifier_store"},
        "provider_deployments": 0,
        "physical_hardware_authorized": False,
    }


def validate_plan(binding, plan):
    identity.exact(
        plan,
        [
            "schema_version",
            "qualification_profile",
            "verifier_store",
            "environments",
            "application_scan_sha256",
        ],
        "IDENTITY_ACCEPTANCE_PLAN_SCHEMA",
    )
    r.require(
        plan["schema_version"] == 1
        and plan["qualification_profile"] == PROFILE
        and binding["repository"] == REPOSITORIES["portal"]
        and binding["component"] == "identity-acceptance"
        and binding["target_environment"] == "production",
        "IDENTITY_ACCEPTANCE_SCOPE",
    )
    identity.exact(
        plan["environments"], identity.ENVIRONMENTS, "IDENTITY_ACCEPTANCE_ENVIRONMENTS"
    )
    for env, selected in plan["environments"].items():
        identity.exact(
            selected,
            ["origins", "browser_file", "identity_file", "products"],
            "IDENTITY_ACCEPTANCE_ENVIRONMENT_SCHEMA",
        )
        identity.exact(selected["origins"], REPOSITORIES, "IDENTITY_ACCEPTANCE_ORIGINS")
        identity.pinned(selected["browser_file"])
        identity.pinned(selected["identity_file"])
        identity.exact(
            selected["products"], REPOSITORIES, "IDENTITY_FOUR_PRODUCTS_REQUIRED"
        )
        for product, value in selected["products"].items():
            identity.exact(
                value,
                ["backend", "frontend", "provider_file", "project_id", "deployment_id"],
                "IDENTITY_PRODUCT_ACCEPTANCE_SCHEMA",
            )
            identity.pinned(value["provider_file"])
            r.require(
                re.fullmatch(r"prj_[A-Za-z0-9]+", value["project_id"])
                and (
                    re.fullmatch(r"dpl_[A-Za-z0-9]+", value["deployment_id"])
                    or env == "production" and value["deployment_id"] == CURRENT
                ),
                "IDENTITY_PROVIDER_IDENTITY",
            )
            for kind in ["backend", "frontend"]:
                reference = value[kind]
                identity.exact(
                    reference,
                    ["store", "record_id", "binding"],
                    "IDENTITY_SIGNED_DEPENDENCY_REFERENCE",
                )
                if reference["record_id"] != CURRENT:
                    identity.common.identifier(reference["record_id"])
                path = Path(reference["store"])
                r.require(
                    path.is_absolute()
                    and str(path) == reference["store"]
                    and ".." not in path.parts,
                    "IDENTITY_DEPENDENCY_STORE_SCOPE",
                )
                accepted = reference["binding"]
                allowed = (
                    COMPONENTS[product]
                    if kind == "backend"
                    else {"frontend", "identity-frontend"}
                )
                r.require(
                    accepted["repository"] == REPOSITORIES[product]
                    and accepted["component"] in allowed,
                    "IDENTITY_DEPENDENCY_COMPONENT_SCOPE",
                )
            origin = urllib.parse.urlsplit(selected["origins"][product])
            r.require(
                origin.scheme == "https"
                and origin.hostname == origin.netloc
                and not origin.path
                and not origin.query
                and not origin.fragment,
                "IDENTITY_ACCEPTANCE_HTTPS_ORIGIN",
            )
        r.require(
            identity.digest(configuration(plan, env))
            == binding["configuration_sha256"][env],
            "IDENTITY_ACCEPTANCE_CONFIGURATION_CHANGED",
        )
    r.require(
        plan["environments"]["production"]["origins"]
        == {
            "portal": "https://portal.onesa.eu",
            "ai": "https://platform.onesa.eu",
            "drone": "https://drone.onesa.eu",
            "robot": "https://robot.onesa.eu",
        }
        and set(plan["environments"]["staging"]["origins"].values()).isdisjoint(
            plan["environments"]["production"]["origins"].values()
        ),
        "IDENTITY_ACCEPTANCE_ORIGIN_ISOLATION",
    )
    return ROOT / "artifacts" / binding["source_tree"]


def signed_dependency(reference, env):
    """Verify the foreign commissioned store read-only; execute no foreign code.

    Product verifiers have different executable hashes. Their independently
    commissioned trust anchors and actual Ed25519 signatures are checked without
    importing a caller-selected module or forging a Portal Store wrapper.
    """
    path = r.private(Path(reference["store"]), directory=True)
    for name in ["trust.json", "policy.json", "public.pem", "records.sqlite"]:
        r.private(path / name)
    trust, policy = r.read(path / "trust.json"), r.read(path / "policy.json")
    anchor = r.read(owner.ANCHOR)
    owner.commissioned(anchor, path, trust)
    r.require(
        r.sha(path / "public.pem") == trust["key_id"]
        and r.sha(path / "policy.json") == trust["policy_sha256"]
        and r.sha(Path(owner.OPENSSL)) == trust["openssl_sha256"],
        "IDENTITY_DEPENDENCY_CUSTODY_CHANGED",
    )
    owner.binding_valid(reference["binding"], policy)
    conn = sqlite3.connect(
        "file:" + str(path / "records.sqlite") + "?mode=ro", uri=True, timeout=20
    )
    chain, visited = [], set()
    expected_kind = "qualification" if env == "staging" else "production-verification"

    def read_record(identifier):
        identity.common.identifier(identifier)
        row = conn.execute(
            "SELECT envelope,revoked,parent,kind,scope,created FROM records WHERE id=?",
            (identifier,),
        ).fetchone()
        r.require(row and row[1] == 0, "IDENTITY_DEPENDENCY_REVOKED_OR_MISSING")
        envelope = json.loads(row[0])
        record, signature = envelope["record"], envelope["signature"]
        r.require(
            signature["algorithm"] == "Ed25519"
            and signature["key_id"] == trust["key_id"],
            "IDENTITY_DEPENDENCY_SIGNER",
        )
        owner.signed_bytes(
            None,
            path / "public.pem",
            owner.canonical(record),
            base64.b64decode(signature["value"], validate=True),
        )
        issued, expiry = dt.datetime.fromisoformat(
            record["issued_at"]
        ), dt.datetime.fromisoformat(record["expires_at"])
        r.require(
            record["schema_version"] == 1
            and record["id"] == identifier
            and record["parent"] == row[2]
            and record["kind"] == row[3]
            and record["issued_at"] == row[5]
            and record["binding"] == reference["binding"]
            and row[4]
            == record["binding"]["repository"] + ":" + record["binding"]["component"]
            and dt.timedelta() < expiry - issued <= dt.timedelta(hours=24)
            and dt.timedelta() <= r.now() - issued <= dt.timedelta(hours=24)
            and record["workflow_run_id"] == 0
            and record["owner_provenance"]["installation_id"]
            == trust["installation_id"]
            and record["owner_provenance"]["verifier_sha256"]
            == trust["verifier_sha256"]
            and record["owner_provenance"]["owner"] == owner.OWNER
            and record["owner_provenance"]["mechanism"]
            == "commissioned-pinned-OpenSSH-and-authenticated-owner",
            "IDENTITY_DEPENDENCY_SIGNATURE_SCOPE",
        )
        return record

    try:
        identifier = reference["record_id"]
        if identifier == CURRENT:
            # Production acceptance IDs do not exist when the integration's
            # staging configuration is bound. Resolve only genuinely signed
            # records for that exact future binding, with one release operation.
            matches = conn.execute(
                "SELECT id,parent,envelope FROM records WHERE kind=? AND revoked=0 ORDER BY sequence DESC LIMIT 1001",
                (expected_kind,),
            ).fetchall()
            r.require(len(matches) <= 1000, "IDENTITY_DEPENDENCY_HISTORY_BOUND")
            matches = [
                row
                for row in matches
                if json.loads(row[2])["record"].get("binding") == reference["binding"]
            ]
            r.require(
                matches and len({row[1] for row in matches}) == 1,
                "IDENTITY_EXACT_ACCEPTED_OPERATION_REQUIRED",
            )
            identifier = matches[0][0]
        while identifier:
            r.require(
                identifier not in visited and len(visited) < 32,
                "IDENTITY_DEPENDENCY_CHAIN_BOUND",
            )
            visited.add(identifier)
            record = read_record(identifier)
            if record["kind"] == "authorization":
                attempt = read_record(record["details"]["attempt_id"])
                r.require(
                    attempt["kind"] == "authorization-attempt"
                    and attempt["parent"] == record["parent"]
                    and record["details"]["decision"] == "approve"
                    and record["details"]["physical_hardware_authorized"] is False,
                    "IDENTITY_DEPENDENCY_AUTHORIZATION_CHAIN",
                )
            chain.append(record)
            identifier = record["parent"]
    finally:
        conn.close()
    r.require(
        chain[0]["kind"] == expected_kind
        and any(row["kind"] == "context" for row in chain),
        "IDENTITY_ACCEPTED_DEPENDENCY_REQUIRED",
    )
    root_context = next(row for row in chain if row["kind"] == "context")
    r.require(
        root_context["details"]["ci"]
        and all(
            type(value.get("run_id")) is int and value["run_id"] > 0
            for value in root_context["details"]["ci"]
        ),
        "IDENTITY_DEPENDENCY_NATIVE_CI_REQUIRED",
    )
    observation = (
        chain[0]["details"]["staging"]["observations"]
        if env == "staging"
        else chain[0]["details"]["observations"]
    )
    phase = "staging" if env == "staging" else "production"
    r.require(
        observation["binding"] == reference["binding"]
        and observation["environment"] == env
        and all(
            observation["checks"].get(name) == "PASS"
            for name in owner.REQUIRED_CHECKS[phase]
        ),
        "IDENTITY_DEPENDENCY_ACCEPTANCE_INCOMPLETE",
    )
    qualified = next((row for row in chain if row["kind"] == "qualification"), None)
    r.require(
        qualified
        and all(
            qualified["details"]["operations"]["observations"]["checks"].get(name)
            == "PASS"
            for name in owner.REQUIRED_CHECKS["operations"]
        ),
        "IDENTITY_DEPENDENCY_OPERATIONAL_QUALIFICATION_REQUIRED",
    )
    return {
        "observation": observation,
        "operation": (
            root_context["id"] if env == "staging" else observation["operation_id"]
        ),
        "record_id": chain[0]["id"],
        "record_sha256": identity.digest(chain[0]),
    }


def provider_get(path, credentials):
    r.require(
        path.startswith("/") and "://" not in path and "?" not in path,
        "IDENTITY_PROVIDER_READ_PATH",
    )
    url = (
        "https://api.vercel.com"
        + path
        + "?"
        + urllib.parse.urlencode({"teamId": credentials["team_id"]})
    )
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": "Bearer " + credentials["token"],
            "User-Agent": "OnesaOwnerIdentityAcceptance/1.0",
        },
    )
    with urllib.request.build_opener(r.NoRedirect()).open(
        request, timeout=30
    ) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
        r.require(
            response.status == 200 and len(raw) <= 4 * 1024 * 1024,
            "IDENTITY_PROVIDER_READBACK_FAILED",
        )
        return json.loads(raw)


def deployment_identity(value, frontend, env):
    """Resolve a future production ID only from exact signed acceptance.

    The candidate's production deployment does not exist when this integration
    profile is staged. Its independently verified, source-bound acceptance is
    the authority for that later ID; a mutable alias or caller-selected provider
    response cannot supply it. Staging and literal production IDs must agree.
    """
    observed = frontend["observation"].get("deployment_id")
    r.require(
        isinstance(observed, str)
        and re.fullmatch(r"dpl_[A-Za-z0-9]+", observed)
        and (
            value["deployment_id"] == observed
            or env == "production" and value["deployment_id"] == CURRENT
        ),
        "IDENTITY_SIGNED_FRONTEND_DEPLOYMENT_CHANGED",
    )
    return observed


def accepted_runtime(product, env, actual, observation):
    expected = (
        observation.get("runtime_targets", {}).get("portal-api-" + env)
        if product == "portal"
        else observation.get("backend_runtime")
    )
    r.require(
        expected == actual,
        "IDENTITY_SIGNED_BACKEND_RUNTIME_CHANGED",
    )


def dependencies(plan, env, accepted=None):
    selected = plan["environments"][env]
    before = r.inventory()
    observed = {}
    for product, value in selected["products"].items():
        backend_reference, frontend_reference = value["backend"], value["frontend"]
        if accepted is not None:
            backend_reference = {
                **backend_reference,
                "record_id": accepted[product]["backend_record_id"],
            }
            frontend_reference = {
                **frontend_reference,
                "record_id": accepted[product]["frontend_record_id"],
            }
        backend = signed_dependency(backend_reference, env)
        frontend = signed_dependency(frontend_reference, env)
        deployment_id = deployment_identity(value, frontend, env)
        name = (
            "onesa-drone-oracle-" + env + "-api-1"
            if product == "drone"
            else "onesa-" + product + "-oracle-api-" + env + "-1"
        )
        row = before[name]
        binding = value["backend"]["binding"]
        actual = identity.recovery_target(row)
        r.require(
            actual["source_commit"] == binding["candidate_commit"]
            and actual["image_id"] == binding["artifact_digest"]
            and r.healthy(row),
            "IDENTITY_SERVED_BACKEND_DIFFERS",
        )
        accepted_runtime(product, env, actual, backend["observation"])
        if product == "portal":
            issuer = json.loads(identity.private_bytes(selected["identity_file"]))
            identity.exact(
                issuer,
                identity.IDENTITY_KEYS,
                "IDENTITY_ACCEPTANCE_ISSUER_CONFIGURATION",
            )
            environment = dict(value.split("=", 1) for value in row["Config"]["Env"])
            r.require(
                issuer["ONESA_IDENTITY_ENABLED"] == "true"
                and all(environment.get(key) == item for key, item in issuer.items()),
                "IDENTITY_ACCEPTED_ISSUER_REGISTRATION_CHANGED",
            )
        credentials = json.loads(identity.private_bytes(value["provider_file"]))
        r.require(
            isinstance(credentials.get("token"), str)
            and len(credentials["token"]) >= 16
            and isinstance(credentials.get("team_id"), str)
            and re.fullmatch(r"team_[A-Za-z0-9]+", credentials["team_id"]),
            "IDENTITY_EXISTING_PROVIDER_CUSTODY",
        )
        deployment = provider_get(
            "/v13/deployments/" + deployment_id, credentials
        )
        meta = deployment.get("meta") or {}
        source_key, operation_key = (
            ("onesaSourceCommit", "onesaOperationID")
            if product == "drone"
            else ("githubCommitSha", "onesaOracleOperation")
        )
        r.require(
            deployment["id"] == deployment_id
            and deployment["projectId"] == value["project_id"]
            and deployment["readyState"] == "READY"
            and meta.get(source_key) == value["frontend"]["binding"]["candidate_commit"]
            and meta.get(operation_key) == frontend["operation"]
            and (
                deployment.get("target") == "production"
                if env == "production"
                else deployment.get("target") in {None, "preview"}
            ),
            "IDENTITY_SERVED_FRONTEND_DIFFERS",
        )
        alias = provider_get(
            "/v4/aliases/"
            + urllib.parse.urlsplit(selected["origins"][product]).hostname,
            credentials,
        )
        actual_id = alias.get("deploymentId") or (alias.get("deployment") or {}).get(
            "id"
        )
        r.require(
            actual_id == deployment_id
            and alias.get("projectId") == value["project_id"],
            "IDENTITY_FRONTEND_ALIAS_CHANGED",
        )
        observed[product] = {
            "backend": actual,
            "backend_record_id": backend["record_id"],
            "frontend_record_id": frontend["record_id"],
            "backend_record_sha256": backend["record_sha256"],
            "frontend_record_sha256": frontend["record_sha256"],
            "frontend_deployment_id": deployment_id,
            "frontend_source_commit": value["frontend"]["binding"]["candidate_commit"],
            "frontend_artifact_digest": value["frontend"]["binding"]["artifact_digest"],
        }
    r.unchanged(before, r.inventory())
    return observed


def stage_path(records):
    contexts = [record for record in records if record["kind"] == "context"]
    r.require(len(contexts) == 1, "IDENTITY_INTEGRATION_CONTEXT_REQUIRED")
    return ROOT / "observations" / contexts[0]["id"] / "receipt.json"


def operations(binding, plan, records):
    path = stage_path(records)
    observed = r.read(path)
    r.require(
        observed["binding"] == binding
        and observed["environment"] == "staging"
        and observed["dependencies"]
        == dependencies(plan, "staging", observed["dependencies"])
        and set(observed["hosted"]["checks"]) == identity.HOSTED_CHECKS
        and all(v is True for v in observed["hosted"]["checks"].values()),
        "IDENTITY_INTEGRATION_STAGING_REQUIRED",
    )
    for row in records:
        if row["kind"] == "qualification":
            r.require(
                row["details"]["staging"]["observations"]["receipt_sha256"]
                == r.sha(path),
                "IDENTITY_INTEGRATION_SIGNED_RECEIPT_CHANGED",
            )
    return {
        "staging_receipt_sha256": r.sha(path),
        "independent_accepted_components": True,
        "provider_deployments": 0,
        "physical_hardware_authorized": False,
    }


def runner(phase, binding, context):
    r.require(phase in CHECKS, "IDENTITY_INTEGRATION_PHASE")
    plan = r.read(PLAN)
    folder = validate_plan(binding, plan)
    records = r.verify_invocation(binding, context, phase, plan)
    identity.source_and_image(binding, plan, folder)
    if phase == "operations":
        value = operations(binding, plan, records)
    elif phase in {"staging", "deploy"}:
        if phase == "deploy":
            operations(binding, plan, records)
        env = "staging" if phase == "staging" else "production"
        identifier = identity.common.identifier(
            context["context_id"] if phase == "staging" else context["operation_id"]
        )
        before_runtime = r.inventory()
        before = dependencies(plan, env)
        target = identity.reserve(
            ROOT / ("observations" if phase == "staging" else "deployments"),
            identifier,
            {
                "binding": binding,
                "context": context,
                "environment": env,
                "request_budget": 1,
                "automatic_retry": False,
            },
        )
        browser = identity.hosted(
            binding, plan, env, identifier, target, scope="integrated"
        )
        r.require(
            before == dependencies(plan, env, before),
            "IDENTITY_COMPONENT_CHANGED_DURING_ACCEPTANCE",
        )
        r.unchanged(before_runtime, r.inventory())
        observed = {
            "state": "INTEGRATED_IDENTITY_OBSERVED_NOT_AUTHORIZATION",
            "binding": binding,
            "environment": env,
            "operation_id": identifier,
            "dependencies": before,
            "hosted": browser,
            "observed_at": r.now().isoformat(),
            "preserved_runtime_sha256": identity.digest(
                {name: r.summary(row) for name, row in before_runtime.items()}
            ),
            "provider_deployments": 0,
            "physical_hardware_authorized": False,
        }
        r.write(target / "receipt.json", observed)
        value = {
            **observed,
            "receipt_sha256": r.sha(target / "receipt.json"),
            "deployment_id": before["portal"]["frontend_deployment_id"],
        }
    else:
        target = (
            ROOT / "deployments" / identity.common.identifier(context["operation_id"])
        )
        intent, observed = r.read(target / "intent.json"), r.read(
            target / "receipt.json"
        )
        r.require(
            intent["binding"] == observed["binding"] == binding
            and intent["context"]["operation_id"] == context["operation_id"]
            and observed["environment"] == "production"
            and observed["state"] == "INTEGRATED_IDENTITY_OBSERVED_NOT_AUTHORIZATION"
            and observed["dependencies"]
            == dependencies(plan, "production", observed["dependencies"])
            and dt.timedelta()
            <= r.now() - dt.datetime.fromisoformat(observed["observed_at"])
            < dt.timedelta(hours=1),
            "IDENTITY_INTEGRATION_DEPLOYMENT_REQUIRED",
        )
        value = {
            **observed,
            "deployment_id": observed["dependencies"]["portal"][
                "frontend_deployment_id"
            ],
            "receipt_sha256": r.sha(target / "receipt.json"),
            "production_writes": 0,
        }
    return {
        **value,
        "binding": binding,
        "environment": "staging" if phase == "staging" else "production",
        "workflow_run_id": 0,
        "observed_at": r.now().isoformat(),
        "checks": {key: "PASS" for key in CHECKS[phase]},
    }


def main():
    request = None
    try:
        r.require(
            os.geteuid() == 0
            and os.getenv("SUDO_USER") == "ubuntu"
            and not os.getenv("GITHUB_ACTIONS"),
            "EXISTING_OWNER_SSH_REQUIRED",
        )
        r.require(len(sys.argv) == 2, "IDENTITY_INTEGRATION_PHASE_REQUIRED")
        raw = sys.stdin.buffer.read(131073)
        r.require(len(raw) <= 131072, "IDENTITY_INTEGRATION_REQUEST_BOUND")
        request = json.loads(raw)
        identity.exact(
            request, ["binding", "context"], "IDENTITY_INTEGRATION_REQUEST_SCHEMA"
        )
        print(
            json.dumps(
                runner(sys.argv[1], request["binding"], request["context"]),
                sort_keys=True,
            )
        )
    except Exception as error:
        identity.record_failure(
            sys.argv[1] if len(sys.argv) == 2 else None,
            request,
            error,
            component="identity-acceptance",
        )
        print(
            json.dumps({"state": "IDENTITY_INTEGRATION_FAILED_INSPECT_WITHOUT_RETRY"})
        )
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
