"""Independent existing-API runtime adapter for the commissioned Oracle verifier.

Its limited scope preserves business/authentication/migration source. A fresh
owned staging database exercises real routes and idle-connection recovery. The
single API-only deployment is durable; production observation is read-only.
Neither caller JSON nor this source module creates release authority.
"""

import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import oracle_portal as r
import oracle_portal_scanner as common
import oracle_portal_scanner_workflow as workflows

PLAN = Path("/etc/onesa/oracle-portal-api-release.json")
ROOT = Path("/var/lib/onesa/release-verification/portal/api")
TARGET = "onesa-portal-oracle-api-production-1"
RUNTIME = Path("/etc/onesa/backends/portal-production.env")
STORAGE = "onesa-portal-oracle-api_production_storage"
SOCKET = "onesa-portal-oracle-staging_scanner_socket"
PRODUCTION_TOOL = "oracle_portal_api_production.mjs"
CHECKS = common.CHECKS


def profile(row):
    value = common.profile(row)
    # Image defaults are separately checked against the exact candidate image
    # and preserved rendered environment; a Node patch may change NODE_VERSION.
    value.pop("environment_sha256")
    value["image_configuration_sha256"] = hashlib.sha256(
        r.canonical(
            {
                key: item
                for key, item in row["Config"].items()
                if key not in {"Hostname", "Image", "Labels", "Env"}
            }
        )
    ).hexdigest()
    return value


def configuration(plan, environment):
    r.require(environment in {"staging", "production"}, "API_ENVIRONMENT")
    return {
        "component": "api",
        "environment": environment,
        **{key: plan[key] for key in plan if key != "verifier_store"},
        "publication_controls_unchanged": True,
        "physical_hardware_authorized": False,
        "production_observation": "read-only-system-metadata-and-existing-public-routes",
    }


def validate_plan(binding, plan):
    common.exact(
        plan,
        [
            "schema_version",
            "verifier_store",
            "baseline",
            "runtime",
            "recipe",
            "rollback",
            "legacy_backup",
            "workflow",
            "production_probe",
        ],
        "API_PLAN_SCHEMA",
    )
    r.require(
        plan["schema_version"] == 1
        and binding["repository"] == common.REPOSITORY
        and binding["component"] == "api"
        and binding["target_environment"] == "production"
        and re.fullmatch(r"[a-f0-9]{40}", binding["candidate_commit"])
        and re.fullmatch(r"[a-f0-9]{40}", binding["source_tree"]),
        "API_COMPONENT_SCOPE",
    )
    workflows.validate_plan(binding, plan)
    r.require(
        isinstance(plan["baseline"], dict)
        and len(plan["baseline"]) >= 11
        and {TARGET, workflows.PRODUCTION_SCANNER, workflows.STAGE}
        <= set(plan["baseline"]),
        "COMPLETE_API_PRESERVATION_BASELINE",
    )
    runtime = plan["runtime"]
    r.require(
        runtime["user"] == "node"
        and runtime["entrypoint"] == ["docker-entrypoint.sh"]
        and runtime["command"] == ["node", "dist/src/server.js"]
        and runtime["read_only"] is True
        and runtime["privileged"] is False
        and not runtime["cap_add"]
        and runtime["cap_drop"] == ["ALL"]
        and runtime["security_opt"] == ["no-new-privileges:true"]
        and not runtime["group_add"]
        and runtime["port_bindings"]
        == {"8300/tcp": [{"HostIp": "127.0.0.1", "HostPort": "18300"}]}
        and runtime["memory"] == 384 * 1024**2
        and runtime["nano_cpus"] == 600000000
        and runtime["pids_limit"] == 128
        and len(runtime["mounts"]) == 1
        and len(runtime["networks"]) == 1
        and runtime["mounts"][0]["Type"] == "volume"
        and runtime["mounts"][0]["Name"] == STORAGE
        and runtime["mounts"][0]["Destination"] == "/app/storage"
        and runtime["mounts"][0]["RW"] is True
        and runtime["init"] is True,
        "EXISTING_PRODUCTION_API_PROFILE_REQUIRED",
    )
    recipe = plan["recipe"]
    common.exact(
        recipe,
        ["project", "directory", "files", "environment_file"],
        "API_RECIPE_SCHEMA",
    )
    identity_file(recipe)
    prefix = "/opt/onesa/backends"
    r.require(
        recipe["project"] == "onesa-portal-oracle-api"
        and recipe["directory"] == prefix
        and len(recipe["files"]) == 1,
        "EXISTING_PRODUCTION_API_RECIPE_REQUIRED",
    )
    item = recipe["files"][0]
    common.exact(item, ["path", "sha256"], "API_RECIPE_PIN_SCHEMA")
    r.require(
        item["path"] == recipe["directory"] + "/portal.yaml"
        and re.fullmatch(r"[a-f0-9]{64}", item["sha256"]),
        "API_RECIPE_PIN",
    )
    common.exact(
        plan["rollback"], ["artifact_digest", "automatic"], "API_ROLLBACK_SCHEMA"
    )
    r.require(
        plan["rollback"]["automatic"] is False
        and plan["rollback"]["artifact_digest"] == plan["baseline"][TARGET]["image"]
        and plan["rollback"]["artifact_digest"] != binding["artifact_digest"],
        "RETAINED_API_ROLLBACK_REQUIRED",
    )
    production = plan["production_probe"]
    common.exact(
        production,
        ["runtime_path", "runtime_sha256", "effective_runtime_sha256"],
        "API_PRODUCTION_PROBE_SCHEMA",
    )
    r.require(
        production["runtime_path"] == str(RUNTIME)
        and all(
            re.fullmatch(r"[a-f0-9]{64}", production[key])
            for key in ["runtime_sha256", "effective_runtime_sha256"]
        ),
        "API_RUNTIME_PIN",
    )
    for environment in ["staging", "production"]:
        r.require(
            hashlib.sha256(r.canonical(configuration(plan, environment))).hexdigest()
            == binding["configuration_sha256"][environment],
            "API_CONFIGURATION_CHANGED",
        )
    return ROOT / "artifacts" / binding["source_tree"]


def source_equivalence(folder, binding, plan):
    import tarfile

    baseline = r.trusted_toolchain(plan)["accepted_api_baseline"]
    common.exact(
        baseline,
        ["candidate_commit", "source_tree", "source_sha256", "artifact_digest"],
        "API_BASELINE_SCHEMA",
    )
    r.require(
        baseline["candidate_commit"] == plan["baseline"][TARGET]["source"]
        and baseline["artifact_digest"] == plan["baseline"][TARGET]["image"],
        "API_BASELINE_NOT_CURRENT_RETAINED_RUNTIME",
    )
    archive = r.private(folder / "baseline-source.tar")
    r.require(
        r.sha(archive) == baseline["source_sha256"], "API_BASELINE_ARCHIVE_CHANGED"
    )
    _, old = r.source_inventory(archive, baseline)
    _, new = r.source_inventory(folder / "source.tar", binding)
    prefix = "onesa-company-portal-backend/"
    changed = {
        name
        for name in old.keys() | new.keys()
        if name.startswith(prefix) and old.get(name) != new.get(name)
    }
    permitted = {
        prefix + name
        for name in [
            ".dockerignore",
            ".env.example",
            "Dockerfile",
            "package.json",
            "package-lock.json",
            "src/config/env.ts",
            "src/jobs/health.ts",
            "src/jobs/polling.ts",
            "src/jobs/worker.ts",
            "src/services/db.ts",
        ]
    }
    r.require(
        changed
        and all(
            name in permitted or name.startswith(prefix + "tests/") for name in changed
        ),
        "API_BUSINESS_OR_MIGRATION_CHANGE_REQUIRES_BROADER_QUALIFICATION",
    )
    with (
        tarfile.open(archive, "r:") as before,
        tarfile.open(folder / "source.tar", "r:") as after,
    ):
        previous = before.extractfile(prefix + "src/services/db.ts").read()
        current = after.extractfile(prefix + "src/services/db.ts").read()
        addition = b"// pg-pool removes the failed idle client before emitting. Without a listener,\n// a provider suspend/resize terminates Node instead of reconnecting on demand.\npool.on('error',()=>console.error(JSON.stringify({event:'database_idle_connection_failed'})));\n"
        anchor = b"const context=new AsyncLocalStorage<pg.PoolClient>();"
        r.require(
            previous.count(anchor) == 1
            and current == previous.replace(anchor, addition + anchor),
            "API_ONLY_IDLE_POOL_ERROR_HANDLING_PERMITTED",
        )
        previous_env = before.extractfile(prefix + "src/config/env.ts").read()
        current_env = after.extractfile(prefix + "src/config/env.ts").read()
        env_anchor = b"export const companyOrigin = process.env.COMPANY_ORIGIN;\n"
        worker_only = b"// Opt-in only: production retains the five-second polling contract.\nexport const workerIdleMaxMs=z.coerce.number().int().min(5000).max(600000).default(5000).parse(process.env.WORKER_IDLE_MAX_MS);\nif(workerIdleMaxMs>5000&&process.env.WORKER_PROFILE!=='staging')throw new Error('Idle worker backoff requires the explicit staging profile');\n"
        r.require(
            previous_env.count(env_anchor) == 1
            and current_env
            == previous_env.replace(env_anchor, env_anchor + worker_only),
            "API_AUTHENTICATION_AND_PUBLICATION_CONFIGURATION_SOURCE_CHANGED",
        )
        previous_package = json.load(before.extractfile(prefix + "package.json"))
        current_package = json.load(after.extractfile(prefix + "package.json"))
        expected_package = json.loads(json.dumps(previous_package))
        r.require(
            expected_package["dependencies"]["nodemailer"] == "^10.0.16",
            "API_EXPECTED_REVIEWED_DEPENDENCY_BASELINE",
        )
        expected_package["dependencies"]["nodemailer"] = "^10.1.4"
        r.require(
            current_package == expected_package,
            "API_ONLY_REVIEWED_MAIL_DEPENDENCY_UPDATE_PERMITTED",
        )
        previous_lock = json.load(before.extractfile(prefix + "package-lock.json"))
        current_lock = json.load(after.extractfile(prefix + "package-lock.json"))
        expected_lock = json.loads(json.dumps(previous_lock))
        expected_lock["packages"][""]["dependencies"]["nodemailer"] = "^10.1.4"
        r.require(
            set(current_lock["packages"]) == set(expected_lock["packages"]),
            "API_DEPENDENCY_GRAPH_CHANGED",
        )
        for name, item in current_lock["packages"].items():
            old_item = expected_lock["packages"][name]
            if item == old_item:
                continue
            library = name.rsplit("/", 1)[-1]
            versions = {
                "fast-uri": {"3.1.8": "3.1.9", "4.2.1": "4.2.3"},
                "nodemailer": {"10.0.16": "10.1.4"},
            }
            r.require(
                library in versions
                and versions[library].get(old_item.get("version"))
                == item.get("version")
                and item.get("resolved")
                == "https://registry.npmjs.org/"
                + library
                + "/-/"
                + library
                + "-"
                + item["version"]
                + ".tgz"
                and isinstance(item.get("integrity"), str)
                and item["integrity"].startswith("sha512-"),
                "API_UNREVIEWED_LOCKED_DEPENDENCY_CHANGE",
            )
            expected_lock["packages"][name] = item
        r.require(current_lock == expected_lock, "API_LOCKFILE_CONFIGURATION_CHANGED")
    return {
        "state": "NARROW_API_RUNTIME_SCOPE_REQUIRES_NEW_HOSTED_ACCEPTANCE",
        "baseline_source": baseline["candidate_commit"],
        "changed_backend_paths": sorted(changed),
        "business_routes_authentication_migrations_unchanged": True,
        "new_processing_authorized": False,
    }


def identity_file(recipe):
    environment = recipe["environment_file"]
    common.exact(environment, ["path", "sha256"], "COMPOSE_IDENTITY_FILE_SCHEMA")
    r.require(
        environment["path"] == "/etc/onesa/backends/portal.images.env"
        and re.fullmatch(r"[a-f0-9]{64}", environment["sha256"]),
        "EXISTING_COMPOSE_IDENTITY_FILE_REQUIRED",
    )
    return environment


def recipe_command(plan, override=None):
    recipe = plan["recipe"]
    args = [
        "/usr/bin/docker",
        "compose",
        "--env-file",
        recipe["environment_file"]["path"],
        "--project-directory",
        recipe["directory"],
        "--project-name",
        recipe["project"],
        "--profile",
        "production",
    ]
    environment = identity_file(recipe)
    r.require(
        r.sha(r.private(Path(environment["path"]))) == environment["sha256"],
        "COMPOSE_IDENTITY_FILE_CHANGED",
    )
    for item in recipe["files"]:
        r.pinned_public_file(Path(item["path"]), item["sha256"])
        args += ["-f", item["path"]]
    return args + (["-f", str(override)] if override else [])


def rendered(plan, override=None):
    return json.loads(
        r.command(recipe_command(plan, override) + ["config", "--format", "json"])
    )


def effective_environment(binding, plan):
    """Bind image defaults plus retained Compose configuration, never rewrite it."""
    r.require(
        r.sha(r.private(RUNTIME)) == plan["production_probe"]["runtime_sha256"],
        "API_RETAINED_RUNTIME_BYTES_CHANGED",
    )
    image = json.loads(r.docker("image", "inspect", binding["artifact_digest"]))[0]
    defaults = dict(item.split("=", 1) for item in image["Config"]["Env"])
    explicit = rendered(plan)["services"]["production"]["environment"]
    expected = {**defaults, **explicit}
    r.require(
        all(
            isinstance(key, str)
            and re.fullmatch(r"[A-Z][A-Z0-9_]*", key)
            and isinstance(value, str)
            and "\n" not in value
            and "\r" not in value
            for key, value in expected.items()
        ),
        "API_EFFECTIVE_ENVIRONMENT_FORMAT",
    )
    raw = "".join(key + "=" + expected[key] + "\n" for key in sorted(expected))
    r.require(
        hashlib.sha256(raw.encode()).hexdigest()
        == plan["production_probe"]["effective_runtime_sha256"],
        "API_EFFECTIVE_ENVIRONMENT_CHANGED",
    )
    row = r.inventory()[TARGET]
    actual = dict(item.split("=", 1) for item in row["Config"]["Env"])
    if row["Id"] == plan["baseline"][TARGET]["container_id"]:
        previous = json.loads(
            r.docker("image", "inspect", plan["baseline"][TARGET]["image"])
        )[0]
        old_defaults = dict(item.split("=", 1) for item in previous["Config"]["Env"])
        changed = {
            key
            for key in set(actual) | set(expected)
            if actual.get(key) != expected.get(key)
        }
        r.require(
            all(
                key not in explicit
                and key in defaults
                and defaults[key] != old_defaults.get(key)
                for key in changed
            ),
            "API_RETAINED_EFFECTIVE_CONFIGURATION_WOULD_CHANGE",
        )
    else:
        r.require(actual == expected, "API_RUNNING_ENVIRONMENT_CHANGED")
    return raw, expected


def retained(plan, *, replacement=False):
    observed = r.inventory()
    r.require(set(observed) == set(plan["baseline"]), "API_WORKLOAD_SET_CHANGED")
    for name, row in observed.items():
        r.require(r.healthy(row), "API_PRESERVED_WORKLOAD_UNHEALTHY")
        if name != TARGET or not replacement:
            r.require(
                r.summary(row) == plan["baseline"][name],
                "API_INDEPENDENT_RUNTIME_CHANGED",
            )
    r.require(
        profile(observed[TARGET]) == plan["runtime"],
        "API_PRODUCTION_PROFILE_CHANGED",
    )
    r.require(
        r.sha(r.private(RUNTIME)) == plan["production_probe"]["runtime_sha256"],
        "API_RUNTIME_CUSTODY_CHANGED",
    )
    return observed


@contextmanager
def component_lock():
    fd = os.open(
        ROOT / "component.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600
    )
    try:
        r.private(ROOT / "component.lock")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def staging(binding, plan, context, folder, records):
    with component_lock():
        common.capacity()
        retained(plan)
        parent = ROOT / "observations"
        parent.mkdir(mode=0o700, exist_ok=True)
        target = parent / common.identifier(context["context_id"])
        target.mkdir(mode=0o700)
        network = "onesa-aq-" + context["context_id"]
        r.write(
            target / "intent.json",
            {
                "binding": binding,
                "context_id": context["context_id"],
                "network": network,
                "automatic_retry": False,
            },
        )
        r.require(
            subprocess.run(
                ["/usr/bin/docker", "network", "inspect", network],
                capture_output=True,
                timeout=20,
                check=False,
            ).returncode
            != 0,
            "API_STAGING_NAMESPACE_EXISTS",
        )
        r.docker(
            "network",
            "create",
            "--label",
            "org.onesa.api-qualification=" + context["context_id"],
            network,
        )
        try:
            identity = workflows.verify_application(binding, plan, folder)
            observed = workflows.observe(
                binding,
                plan,
                folder,
                context["context_id"],
                records,
                network,
                SOCKET,
                target,
            )
            conditional = observed["provider_conditional_ownership"]
            r.require(
                conditional["conditional_object_ownership"] is True
                and conditional["synthetic_object_cleanup"] is True,
                "API_PROVIDER_CONDITIONAL_OWNERSHIP_REQUIRED",
            )
            retained(plan)
            value = {
                "binding": binding,
                "context_id": context["context_id"],
                "status": "PASS",
                "application_binding": identity,
                "workflows": observed,
                "production_schema_migrations": 0,
                "existing_application_data_unchanged": True,
            }
            r.write(target / "receipt.json", value)
            return {"receipt_sha256": r.sha(target / "receipt.json"), "receipt": value}
        finally:
            row = json.loads(r.docker("network", "inspect", network))[0]
            r.require(
                row["Labels"].get("org.onesa.api-qualification")
                == context["context_id"],
                "API_STAGING_CLEANUP_OWNERSHIP",
            )
            r.docker("network", "rm", network)
            retained(plan)


def operations(binding, plan, records):
    retained(plan)
    common.capacity()
    for timer in ["onesa-portal-backup.timer", "onesa-portal-monitor.timer"]:
        r.require(
            r.command(["/usr/bin/systemctl", "is-active", timer]).strip() == b"active",
            "API_RECOVERY_TIMER_INACTIVE",
        )
    backup = r.read(Path("/var/lib/onesa/operations/backup-success.json"))
    r.require(
        backup["passed"] is True
        and backup["consistent_snapshot"] is True
        and dt.timedelta()
        <= r.now() - dt.datetime.fromisoformat(backup["verified_at"])
        < dt.timedelta(hours=36),
        "API_BACKUP_STALE",
    )
    transport = plan["legacy_backup"]
    r.require(
        transport["transport_image"] == r.trusted_toolchain(plan)["transport_image"]
        and transport["transport_env"] == "/etc/onesa/portal-production.env"
        and transport["transport_runtime_sha256"]
        == r.sha(r.private(Path(transport["transport_env"]))),
        "API_BACKUP_CUSTODY_CHANGED",
    )
    readback = r.inspect_database_backup(backup, plan)
    contexts = [record for record in records if record["kind"] == "context"]
    r.require(len(contexts) == 1, "API_SIGNED_CONTEXT_REQUIRED")
    path = ROOT / "observations" / contexts[0]["id"] / "receipt.json"
    observed = r.read(path)
    r.require(
        observed["binding"] == binding
        and observed["status"] == "PASS"
        and observed["workflows"]["state"] == "API_WORKFLOWS_OBSERVED_NOT_AUTHORIZATION"
        and observed["existing_application_data_unchanged"] is True,
        "API_STAGING_EVIDENCE_MISSING",
    )
    for qualified in [
        record for record in records if record["kind"] == "qualification"
    ]:
        r.require(
            qualified["details"]["staging"]["observations"]["receipt_sha256"]
            == r.sha(path),
            "API_SIGNED_STAGING_RECEIPT_CHANGED",
        )
    r.require(
        json.loads(r.docker("image", "inspect", plan["rollback"]["artifact_digest"]))[
            0
        ]["Id"]
        == plan["rollback"]["artifact_digest"],
        "API_ROLLBACK_IMAGE_MISSING",
    )
    return {
        "backup_readback": readback,
        "staging_receipt_sha256": r.sha(path),
        "rollback_mode": "explicit-owner-only-preserved-recipe-and-image",
        "production_schema_migrations": 0,
    }


def deployment_folder(operation):
    return ROOT / "deployments" / common.identifier(operation)


def previous_operations():
    parent = ROOT / "deployments"
    if not parent.exists():
        return
    r.private(parent, directory=True)
    paths = list(parent.iterdir())
    r.require(len(paths) < 1000, "API_DEPLOYMENT_HISTORY_BOUND")
    for path in paths:
        r.private(path, directory=True)
        common.identifier(path.name)
        if not (path / "request.json").exists():
            continue
        request = r.read(path / "request.json")
        r.require(
            request["binding"]["component"] == "api"
            and request["binding"]["repository"] == common.REPOSITORY
            and request["context"]["operation_id"] == path.name,
            "API_PREVIOUS_OPERATION_SCOPE",
        )
        r.verify_invocation(
            request["binding"],
            {"operation_id": path.name, "read_only": True},
            "production",
            {"verifier_store": request["verifier_store"]},
            dependency=True,
        )


def production_probe(binding, plan, context, records, target):
    tool = Path(__file__).with_name(PRODUCTION_TOOL)
    expected = r.trusted_toolchain(plan)["workflow_files"][
        "scripts/release/" + PRODUCTION_TOOL
    ]
    r.pinned_public_file(tool, expected)
    contexts = [record for record in records if record["kind"] == "context"]
    r.require(len(contexts) == 1, "API_PRODUCTION_SIGNED_CONTEXT_REQUIRED")
    ci = contexts[0]["details"]["ci"]
    r.require(
        ci and all(type(row.get("run_id")) is int and row["run_id"] > 0 for row in ci),
        "API_GENUINE_CI_REQUIRED",
    )
    raw_environment, _values = effective_environment(binding, plan)
    request = {
        "binding": binding,
        "operation_id": context["operation_id"],
        "environment": "production",
        "ci_run_id": ci[0]["run_id"],
        "runtime_sha256": plan["production_probe"]["effective_runtime_sha256"],
        "mode": "read-only",
    }
    program = (
        tool.read_text()
        + "\nimport fs from 'node:fs';\nconst v=JSON.parse(fs.readFileSync(0,'utf8'));\ntry{console.log(JSON.stringify(await live(v.request,v.raw)));}catch{console.log(JSON.stringify({state:'API_PRODUCTION_PROBE_FAILED'}));process.exitCode=1;}\n"
    )
    operation = target / ("observation-" + str(__import__("time").time_ns()) + ".json")
    r.write(
        operation,
        {"request": request, "production_writes": 0, "deployment_requests": 0},
    )
    raw = r.docker(
        "exec",
        "-i",
        "--user",
        "node",
        TARGET,
        "node",
        "--input-type=module",
        "-e",
        program,
        data=r.canonical({"request": request, "raw": raw_environment}),
        timeout=60,
    )
    value = json.loads(raw)
    r.require(
        value["state"] == "API_READ_ONLY_RUNTIME_OBSERVED_NOT_AUTHORIZATION"
        and value["binding"] == binding
        and value["operation_id"] == context["operation_id"]
        and value["ci_run_id"] == ci[0]["run_id"]
        and value["database_tls_and_role"] is True
        and value["schema_current"] is True
        and value["production_writes"] == 0
        and value["release_records_issued"] == 0,
        "API_PRODUCTION_READBACK_FAILED",
    )
    # These are genuine HTTPS reads through the retained existing ingress. This
    # narrow runtime profile cannot add routes, business processing or accounts.
    api = r.readiness_and_denials({}, "production")
    r.write(operation.with_suffix(".receipt.json"), {**value, "public_ingress": api})
    return {**value, "public_ingress": api}


def production(binding, plan, context, records):
    target = deployment_folder(context["operation_id"])
    request = r.read(target / "request.json")
    r.require(
        request["binding"] == binding
        and request["context"]["operation_id"] == context["operation_id"]
        and request["request_budget"] == 1
        and request["automatic_retry"] is False,
        "API_DURABLE_REQUEST_REQUIRED",
    )
    row = retained(plan, replacement=True)[TARGET]
    labels = row["Config"].get("Labels", {})
    r.require(
        row["Id"] != plan["baseline"][TARGET]["container_id"]
        and row["Image"] == binding["artifact_digest"]
        and labels.get("org.onesa.source-commit") == binding["candidate_commit"]
        and labels.get("org.onesa.release-operation") == context["operation_id"],
        "ACTUAL_API_IDENTITY_MISMATCH",
    )
    r.require(
        r.sha(target / "api-override.json") == request["override_sha256"],
        "API_OVERRIDE_CHANGED",
    )
    effective_environment(binding, plan)
    r.require(r.healthy(row), "API_ACTUAL_RUNNING_READINESS_REQUIRED")
    observation = production_probe(binding, plan, context, records, target)
    retained(plan, replacement=True)
    return {
        "operation_id": context["operation_id"],
        "deployment_id": row["Id"],
        "artifact_digest": row["Image"],
        "source_commit": binding["candidate_commit"],
        "runtime_observation": observation,
        "production_schema_migrations": 0,
        "physical_hardware_authorized": False,
    }


def deploy(binding, plan, context, folder, records):
    with component_lock():
        target = deployment_folder(context["operation_id"])
        r.require(not target.exists(), "API_OPERATION_EXISTS_INSPECT_ONLY")
        previous_operations()
        retained(plan)
        workflows.verify_application(binding, plan, folder)
        effective_environment(binding, plan)
        parent = ROOT / "deployments"
        parent.mkdir(mode=0o700, exist_ok=True)
        target.mkdir(mode=0o700)
        original = rendered(plan)
        labels = dict(original["services"]["production"].get("labels") or {})
        labels.update(
            {
                "org.onesa.source-commit": binding["candidate_commit"],
                "org.onesa.release-operation": context["operation_id"],
            }
        )
        override = target / "api-override.json"
        r.write(
            override,
            {
                "services": {
                    "production": {
                        "image": binding["artifact_digest"],
                        "labels": labels,
                    }
                }
            },
        )
        expected = json.loads(json.dumps(original))
        expected["services"]["production"].update(
            image=binding["artifact_digest"], labels=labels
        )
        r.require(
            rendered(plan, override) == expected,
            "API_COMPOSE_WOULD_CHANGE_RETAINED_SETTINGS",
        )
        r.write(
            target / "request.json",
            {
                "binding": binding,
                "context": context,
                "verifier_store": plan["verifier_store"],
                "request_budget": 1,
                "automatic_retry": False,
                "override_sha256": r.sha(override),
                "processing_scope": "existing-runtime-recovery-no-new-business-code",
                "recorded_at": r.now().isoformat(),
            },
        )
        try:
            result = subprocess.run(
                recipe_command(plan, override)
                + [
                    "up",
                    "--no-deps",
                    "--no-build",
                    "--pull",
                    "never",
                    "--wait",
                    "--wait-timeout",
                    "240",
                    "production",
                ],
                capture_output=True,
                timeout=300,
                check=False,
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            )
        except subprocess.TimeoutExpired as error:
            r.write_raw(target / "provider-command.stdout", error.stdout or b"")
            r.write_raw(target / "provider-command.stderr", error.stderr or b"")
            r.write(
                target / "provider-command-result.json",
                {"state": "TIMED_OUT_OUTCOME_UNCERTAIN", "automatic_retry": False},
            )
            raise r.Refused("API_REQUEST_INTERRUPTED_INSPECT_ONLY") from None
        r.write_raw(target / "provider-command.stdout", result.stdout)
        r.write_raw(target / "provider-command.stderr", result.stderr)
        r.write(
            target / "provider-command-result.json",
            {"returncode": result.returncode, "automatic_retry": False},
        )
        r.require(result.returncode == 0, "API_REQUEST_FAILED_INSPECT_ONLY")
        row = retained(plan, replacement=True)[TARGET]
        r.require(
            row["Image"] == binding["artifact_digest"]
            and row["Config"]["Labels"].get("org.onesa.release-operation")
            == context["operation_id"],
            "API_RUNNING_IDENTITY_REQUIRED",
        )
        value = production(binding, plan, context, records)
        r.write(target / "provider-receipt.json", value)
        return value


def runner(phase, binding, context):
    r.require(phase in CHECKS, "API_PHASE_SCOPE")
    plan = r.read(PLAN)
    folder = validate_plan(binding, plan)
    source_equivalence(folder, binding, plan)
    records = r.verify_invocation(binding, context, phase, plan)
    if phase == "staging":
        details = staging(binding, plan, context, folder, records)
    elif phase == "operations":
        details = operations(binding, plan, records)
    elif phase == "deploy":
        details = deploy(binding, plan, context, folder, records)
    else:
        details = production(binding, plan, context, records)
    return {
        **details,
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
        r.require(len(sys.argv) == 2, "API_PHASE_REQUIRED")
        raw = sys.stdin.buffer.read(131073)
        r.require(len(raw) <= 131072, "API_REQUEST_BOUND")
        request = json.loads(raw)
        common.exact(request, ["binding", "context"], "API_REQUEST_SCHEMA")
        print(
            json.dumps(
                runner(sys.argv[1], request["binding"], request["context"]),
                sort_keys=True,
            )
        )
    except Exception as error:  # noqa: BLE001 -- private configuration never leaves CLI
        common.record_failure(
            sys.argv[1] if len(sys.argv) == 2 else None,
            request,
            error,
            component="api",
        )
        print(json.dumps({"state": "API_OBSERVATION_FAILED_INSPECT_WITHOUT_RETRY"}))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
