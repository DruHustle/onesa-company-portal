"""Source-bound shared identity release through the commissioned owner verifier.

This separate profile may migrate 012 -> 014 and replace the existing Portal API
and worker together. The narrow API/worker profiles keep their original scope.
Every write has a durable, single-use intent. An interrupted operation is inspected,
never retried automatically. No supplied receipt creates release authority.
"""

import base64
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import oracle_portal as r
import oracle_portal_scanner as common

PROFILE = "portal-shared-identity-v1"
PLAN = Path("/etc/onesa/oracle-portal-identity-release.json")
ROOT = Path("/var/lib/onesa/release-verification/portal/identity")
PREFIX = "onesa-company-portal-backend/"
MIGRATIONS = {
    "013_onesa_identity.sql": "ce7f4ab09f7fafb915b4a4e8b1657ef1e6520494bd28a0492fc3d46d0f4d79e7",
    "014_identity_grant_sessions.sql": "a45640fc7a946f410033c0cc9cd666bfcb2e6a8e02a4f5a200bc2b548f7ce03f",
}
ENVIRONMENTS = ("staging", "production")
TARGETS = {
    env: {
        "api": "onesa-portal-oracle-api-" + env + "-1",
        "worker": "onesa-portal-oracle-" + env + "-worker-1",
    }
    for env in ENVIRONMENTS
}
IDENTITY_KEYS = {"ONESA_IDENTITY_ENABLED", "ONESA_IDENTITY_CONFIG_B64"}
CHECKS = {phase: set(values) for phase, values in common.CHECKS.items()}
CHECKS["staging"] |= {
    "identity_migration",
    "identity_hosted_acceptance",
    "identity_rollback",
}
CHECKS["operations"] |= {"identity_restore"}
CHECKS["production"] |= {"identity_migration", "identity_hosted_acceptance"}
HOSTED_CHECKS = {
    "registration_verification_delivery",
    "portal_member_access",
    "portal_administrator_access",
    "administrator_step_up",
    "ai_authenticated_workspace",
    "drone_authorized_workspace",
    "robot_readonly_simulation",
    "global_administrator_products",
    "member_administrator_denial",
    "one_product_entitlement",
    "two_product_entitlements",
    "access_request_approval",
    "product_revocation",
    "password_reset_delivery",
    "global_session_revocation",
}
ACCOUNT_CHECKS = HOSTED_CHECKS - {
    "ai_authenticated_workspace",
    "drone_authorized_workspace",
    "robot_readonly_simulation",
    "global_administrator_products",
    "product_revocation",
    "one_product_entitlement",
    "two_product_entitlements",
    "access_request_approval",
}


def digest(value):
    return hashlib.sha256(r.canonical(value)).hexdigest()


def pin(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value)


def exact(value, fields, code):
    common.exact(value, fields, code)


def pinned(value, path=None):
    exact(value, ["path", "sha256"], "IDENTITY_PRIVATE_FILE_PIN")
    name = value["path"]
    r.require(
        isinstance(name, str)
        and (name == path if path else name.startswith("/etc/onesa/identity/"))
        and str(Path(name)) == name
        and ".." not in Path(name).parts
        and pin(value["sha256"]),
        "IDENTITY_PRIVATE_FILE_SCOPE",
    )
    return Path(name)


def private_bytes(value, path=None, limit=131072):
    file = r.private(pinned(value, path))
    r.require(
        file.stat().st_size <= limit and r.sha(file) == value["sha256"],
        "IDENTITY_PRIVATE_FILE_CHANGED",
    )
    return file.read_bytes()


def identity_source_files(files):
    """The installation pins the complete backend, including vendored tooling.

    CI's reviewed current-main tree supplies these pins. A candidate cannot add,
    remove or replace an authentication, migration, dependency or build byte after
    installation. This does not broaden the original API source-equivalence gate.
    """
    selected = {name: value for name, value in files.items() if name.startswith(PREFIX)}
    required = {
        PREFIX + name
        for name in [
            "Dockerfile",
            "package.json",
            "package-lock.json",
            "src/identity/config.ts",
            "src/identity/routes.ts",
            "src/identity/provider.ts",
            "src/identity/accounts.ts",
            "src/jobs/worker.ts",
            "src/services/database-readiness.ts",
        ]
    }
    r.require(required <= set(selected), "IDENTITY_COMPLETE_SOURCE_REQUIRED")
    migrations = {
        name.removeprefix(PREFIX + "migrations/"): value
        for name, value in selected.items()
        if name.startswith(PREFIX + "migrations/")
    }
    r.require(
        len(migrations) == 14
        and all(
            re.fullmatch(r"%03d_[a-z_]+\.sql" % (i + 1), name)
            for i, name in enumerate(sorted(migrations))
        )
        and all(migrations.get(name) == value for name, value in MIGRATIONS.items()),
        "IDENTITY_REVIEWED_012_TO_014_ONLY",
    )
    return selected


def configuration(plan, environment):
    r.require(environment in ENVIRONMENTS, "IDENTITY_ENVIRONMENT")
    return {
        "component": "identity",
        "environment": environment,
        **{k: v for k, v in plan.items() if k != "verifier_store"},
        "automatic_retry": False,
        "down_migrations": False,
        "physical_hardware_authorized": False,
    }


def validate_recipe(value, env, kind):
    exact(
        value,
        ["project", "directory", "files", "environment_file"],
        "IDENTITY_RECIPE_SCHEMA",
    )
    directory = value["directory"]
    if kind == "api":
        r.require(
            value["project"] == "onesa-portal-oracle-api"
            and directory == "/opt/onesa/backends",
            "IDENTITY_API_RECIPE_SCOPE",
        )
        expected_file, expected_env = (
            directory + "/portal.yaml",
            "/etc/onesa/backends/portal.images.env",
        )
    else:
        r.require(
            value["project"] == "onesa-portal-oracle-" + env
            and re.fullmatch(
                r"/opt/onesa/portal-" + env + r"/releases/[a-f0-9]{40}", directory
            ),
            "IDENTITY_WORKER_RECIPE_SCOPE",
        )
        expected_file, expected_env = (
            directory + "/compose.yaml",
            directory + "/release.env",
        )
    r.require(
        isinstance(value["files"], list) and len(value["files"]) == 1,
        "IDENTITY_SINGLE_EXISTING_RECIPE",
    )
    pinned(value["files"][0], expected_file)
    pinned(value["environment_file"], expected_env)


def validate_plan(binding, plan):
    exact(
        plan,
        [
            "schema_version",
            "qualification_profile",
            "verifier_store",
            "baseline",
            "environments",
            "application_scan_sha256",
            "legacy_backup",
            "restore",
            "privacy_decision",
        ],
        "IDENTITY_PLAN_SCHEMA",
    )
    r.require(
        plan["schema_version"] == 1
        and plan["qualification_profile"] == PROFILE
        and binding["repository"] == common.REPOSITORY
        and binding["component"] == "identity"
        and binding["target_environment"] == "production"
        and re.fullmatch(r"[a-f0-9]{40}", binding["candidate_commit"])
        and re.fullmatch(r"[a-f0-9]{40}", binding["source_tree"])
        and pin(plan["application_scan_sha256"])
        and plan["privacy_decision"] == "G14_DEFERRED_BY_OWNER_PRELAUNCH",
        "IDENTITY_RELEASE_SCOPE",
    )
    names = {name for values in TARGETS.values() for name in values.values()}
    r.require(
        isinstance(plan["baseline"], dict)
        and len(plan["baseline"]) >= 11
        and names <= set(plan["baseline"]),
        "IDENTITY_COMPLETE_RUNTIME_BASELINE",
    )
    exact(plan["environments"], ENVIRONMENTS, "IDENTITY_ENVIRONMENTS")
    for env, selected in plan["environments"].items():
        exact(
            selected,
            [
                "api",
                "worker",
                "identity_file",
                "database_file",
                "browser_file",
                "origins",
            ],
            "IDENTITY_ENVIRONMENT_SCHEMA",
        )
        for key in ["identity_file", "database_file", "browser_file"]:
            pinned(selected[key])
        exact(
            selected["origins"], ["portal", "ai", "drone", "robot"], "IDENTITY_ORIGINS"
        )
        for origin in selected["origins"].values():
            parsed = urlsplit(origin)
            r.require(
                parsed.scheme == "https"
                and parsed.netloc == parsed.hostname
                and not parsed.path
                and not parsed.query
                and not parsed.fragment,
                "IDENTITY_HTTPS_ORIGIN",
            )
        r.require(
            len(set(selected["origins"].values())) == 4, "IDENTITY_DISTINCT_ORIGINS"
        )
        if env == "production":
            r.require(
                selected["origins"]
                == {
                    "portal": "https://portal.onesa.eu",
                    "ai": "https://platform.onesa.eu",
                    "drone": "https://drone.onesa.eu",
                    "robot": "https://robot.onesa.eu",
                },
                "IDENTITY_CANONICAL_PRODUCTION_ORIGINS",
            )
        for kind in ["api", "worker"]:
            runtime = selected[kind]
            exact(
                runtime,
                ["runtime_file", "recipe", "profile_sha256"],
                "IDENTITY_RUNTIME_SCHEMA",
            )
            expected = (
                "/etc/onesa/"
                + ("backends/portal-" if kind == "api" else "portal-")
                + env
                + ".env"
            )
            pinned(runtime["runtime_file"], expected)
            r.require(pin(runtime["profile_sha256"]), "IDENTITY_RUNTIME_PROFILE_PIN")
            validate_recipe(runtime["recipe"], env, kind)
    r.require(
        set(plan["environments"]["staging"]["origins"].values()).isdisjoint(
            plan["environments"]["production"]["origins"].values()
        ),
        "IDENTITY_STAGING_ORIGIN_ISOLATION",
    )
    for env in ENVIRONMENTS:
        r.require(
            digest(configuration(plan, env)) == binding["configuration_sha256"][env],
            "IDENTITY_CONFIGURATION_CHANGED",
        )
    return ROOT / "artifacts" / binding["source_tree"]


def stable_profile(row):
    value = common.profile(row)
    value.pop("environment_sha256")
    value["image_configuration_sha256"] = digest(
        {
            k: v
            for k, v in row["Config"].items()
            if k not in {"Hostname", "Image", "Labels", "Env"}
        }
    )
    labels = row["Config"].get("Labels") or {}
    value["compose_project"] = labels.get("com.docker.compose.project")
    value["compose_directory"] = labels.get("com.docker.compose.project.working_dir")
    return value


def recovery_target(row):
    """Same byte contract as oracle_recovery.fingerprint; no secret values emitted."""
    labels = row["Config"].get("Labels") or {}
    return {
        "container_id": row["Id"],
        "image_id": row["Image"],
        "source_commit": labels.get("org.onesa.source-commit")
        or labels.get("org.opencontainers.image.revision"),
        "configuration_sha256": digest(
            {
                "Config": row["Config"],
                "HostConfig": row["HostConfig"],
                "Mounts": row["Mounts"],
                "Networks": {
                    name: value["NetworkID"]
                    for name, value in row["NetworkSettings"]["Networks"].items()
                },
            }
        ),
    }


def preserved(plan, replacements=()):
    rows = r.inventory()
    r.require(set(rows) == set(plan["baseline"]), "IDENTITY_RUNTIME_INVENTORY_CHANGED")
    for name, expected in plan["baseline"].items():
        if name not in replacements:
            r.require(
                r.summary(rows[name]) == expected,
                "IDENTITY_INDEPENDENT_RUNTIME_CHANGED",
            )
    for env in ENVIRONMENTS:
        for kind, name in TARGETS[env].items():
            row = rows[name]
            r.require(
                digest(stable_profile(row))
                == plan["environments"][env][kind]["profile_sha256"],
                "IDENTITY_RUNTIME_PROFILE_CHANGED",
            )
            host, config = row["HostConfig"], row["Config"]
            r.require(
                config["User"] == "node"
                and config["Entrypoint"] == ["docker-entrypoint.sh"]
                and config["Cmd"]
                == [
                    "node",
                    (
                        "dist/src/server.js"
                        if kind == "api"
                        else "dist/src/jobs/worker.js"
                    ),
                ]
                and host["ReadonlyRootfs"] is True
                and host["Privileged"] is False
                and not host["CapAdd"]
                and host["CapDrop"] == ["ALL"]
                and host["SecurityOpt"] == ["no-new-privileges:true"]
                and host["PidsLimit"] == 128
                and len(row["NetworkSettings"]["Networks"]) == 1,
                "IDENTITY_EXISTING_RESTRICTED_RUNTIME_REQUIRED",
            )
    return rows


def source_and_image(binding, plan, folder):
    source = r.private(folder / "source.tar")
    r.require(
        r.sha(source) == binding["source_sha256"], "IDENTITY_SOURCE_ARCHIVE_CHANGED"
    )
    _, files = r.source_inventory(source, binding)
    tool = r.trusted_toolchain(plan)
    r.require(
        all(
            tool[key] == binding[key if key != "source_commit" else "candidate_commit"]
            for key in ["source_commit", "source_tree", "source_sha256"]
        )
        and tool["identity_files"] == identity_source_files(files),
        "IDENTITY_SOURCE_DIFFERS_FROM_REVIEWED_INSTALLATION",
    )
    for upstream, expected in tool["workflow_files"].items():
        name = Path(upstream).name
        r.require(files.get(upstream) == expected, "IDENTITY_TOOL_SOURCE_CHANGED")
        r.pinned_public_file(Path(__file__).with_name(name), expected)
    build = r.read(folder / "build.json")
    r.require(
        r.sha(folder / "build.json") == binding["build_sha256"]
        and all(
            build.get(key) == binding[key]
            for key in [
                "repository",
                "component",
                "candidate_commit",
                "source_tree",
                "source_sha256",
                "artifact_digest",
            ]
        )
        and build.get("architecture") == "arm64"
        and build.get("dockerfile_sha256") == files[PREFIX + "Dockerfile"],
        "IDENTITY_BUILD_SOURCE_CHANGED",
    )
    image = json.loads(r.docker("image", "inspect", binding["artifact_digest"]))[0]
    config = image["Config"]
    labels = config.get("Labels") or {}
    defaults = dict(item.split("=", 1) for item in config["Env"])
    r.require(
        image["Id"] == binding["artifact_digest"]
        and image["Os"] == "linux"
        and image["Architecture"] == "arm64"
        and config["User"] == "node"
        and config["Entrypoint"] == ["docker-entrypoint.sh"]
        and config["Cmd"] == ["node", "dist/src/server.js"]
        and labels.get("org.opencontainers.image.revision")
        == binding["candidate_commit"]
        and labels.get("org.onesa.source-sha256") == binding["source_sha256"]
        and set(defaults)
        <= {
            "PATH",
            "NODE_VERSION",
            "YARN_VERSION",
            "NODE_ENV",
            "PORT",
            "STORAGE_DIR",
            "NODE_OPTIONS",
        }
        and defaults.get("NODE_VERSION") == "24.22.1"
        and defaults.get("NODE_ENV") == "production"
        and defaults.get("NODE_OPTIONS")
        == "--import=/app/dist/src/security/tls-trust.js",
        "IDENTITY_ACTUAL_IMAGE_SOURCE_CHANGED",
    )
    r.require(
        r.sha(r.private(folder / "scan.json")) == plan["application_scan_sha256"],
        "IDENTITY_SCAN_CHANGED",
    )
    r.image_security(r.read(folder / "scan.json"), image["Id"])
    migrations = {
        name.removeprefix(PREFIX + "migrations/"): value
        for name, value in files.items()
        if name.startswith(PREFIX + "migrations/")
    }
    expected = {
        "/app/" + name.removeprefix(PREFIX): value
        for name, value in files.items()
        if name in {PREFIX + "package.json", PREFIX + "package-lock.json"}
        or name.startswith(PREFIX + "migrations/")
    }
    output = r.docker(
        "run",
        "--rm",
        "--pull=never",
        "--network",
        "none",
        "--read-only",
        "--memory",
        "64m",
        "--cpus",
        "0.1",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--entrypoint",
        "sha256sum",
        image["Id"],
        *sorted(expected),
    )
    observed = {}
    for line in output.decode().splitlines():
        checksum, path = line.split("  ", 1)
        r.require(path not in observed, "IDENTITY_DUPLICATE_IMAGE_FILE")
        observed[path] = checksum
    r.require(observed == expected, "IDENTITY_IMAGE_MIGRATIONS_OR_DEPENDENCIES_CHANGED")
    return migrations


def recipe_command(runtime, env, kind, override=None):
    recipe = runtime["recipe"]
    command = [
        "/usr/bin/docker",
        "compose",
        "--env-file",
        recipe["environment_file"]["path"],
        "--project-directory",
        recipe["directory"],
        "--project-name",
        recipe["project"],
        "--profile",
        env if kind == "api" else "jobs",
    ]
    private_bytes(recipe["environment_file"], recipe["environment_file"]["path"])
    for selected in recipe["files"]:
        private_bytes(selected, selected["path"], limit=2 * 1024 * 1024)
        command += ["-f", selected["path"]]
    if override is not None:
        r.private(override)
        command += ["-f", str(override)]
    return command


def rendered(runtime, env, kind, override=None):
    return json.loads(
        r.command(
            recipe_command(runtime, env, kind, override)
            + ["config", "--format", "json"]
        )
    )


def identity_values(binding, plan, env):
    selected = plan["environments"][env]
    values = json.loads(private_bytes(selected["identity_file"]))
    exact(values, IDENTITY_KEYS, "IDENTITY_ONLY_APPROVED_CONFIGURATION_KEYS")
    r.require(
        values["ONESA_IDENTITY_ENABLED"] == "true"
        and isinstance(values["ONESA_IDENTITY_CONFIG_B64"], str)
        and len(values["ONESA_IDENTITY_CONFIG_B64"]) <= 65536,
        "IDENTITY_EXPLICIT_ENABLE_REQUIRED",
    )
    decoded = json.loads(
        base64.b64decode(values["ONESA_IDENTITY_CONFIG_B64"], validate=True)
    )
    r.require(
        decoded["issuer"] == selected["origins"]["portal"] + "/api/v1/identity"
        and {c["product"] for c in decoded["clients"]} == {"ai", "drone", "robot"}
        and len(decoded["clients"]) == 3,
        "IDENTITY_ALL_PRODUCTS_REQUIRED",
    )
    for client in decoded["clients"]:
        r.require(
            client["applicationUrl"] == selected["origins"][client["product"]]
            and client["redirectUri"].startswith(client["applicationUrl"] + "/"),
            "IDENTITY_EXACT_PRODUCT_ORIGIN",
        )
    # Use the actual reviewed backend parser, including RSA validation. Values
    # travel only on stdin, never in Docker arguments, stdout or release records.
    program = "import fs from 'node:fs';import {identityConfiguration} from '/app/dist/src/identity/config.js';const x=JSON.parse(fs.readFileSync(0,'utf8'));if(!identityConfiguration(x.values,x.origin))throw Error();console.log('IDENTITY_CONFIGURATION_VALID');"
    observed = r.docker(
        "run",
        "--rm",
        "-i",
        "--pull=never",
        "--network",
        "none",
        "--read-only",
        "--memory",
        "128m",
        "--cpus",
        "0.1",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--entrypoint",
        "node",
        binding["artifact_digest"],
        "--input-type=module",
        "-e",
        program,
        data=r.canonical({"values": values, "origin": selected["origins"]["portal"]}),
    )
    r.require(
        observed.strip() == b"IDENTITY_CONFIGURATION_VALID",
        "IDENTITY_CONFIGURATION_REJECTED",
    )
    return values


def validate_custody(plan):
    """Cross-check the existing API/worker credentials without exposing values."""
    databases = []
    for env in ENVIRONMENTS:
        selected = plan["environments"][env]
        custody = json.loads(private_bytes(selected["database_file"]))
        exact(custody, ["database", "owner_uri"], "IDENTITY_DATABASE_CUSTODY_SCHEMA")
        database = custody["database"]
        exact(
            database,
            ["host", "database", "owner_role", "application_role"],
            "IDENTITY_DATABASE_SCOPE",
        )
        identities = []
        for kind in ["api", "worker"]:
            pointer = selected[kind]["runtime_file"]
            private_bytes(pointer, pointer["path"])
            values = r.runtime_values(Path(pointer["path"]))
            r.require(
                not IDENTITY_KEYS & set(values),
                "IDENTITY_BASELINE_MUST_BE_FEATURE_DISABLED",
            )
            uri = urlsplit(values["DATABASE_URL"])
            r.require(
                uri.scheme in {"postgres", "postgresql"}
                and uri.hostname == database["host"]
                and uri.path == "/" + database["database"]
                and uri.username == database["application_role"]
                and values["PUBLIC_ORIGIN"] == selected["origins"]["portal"],
                "IDENTITY_RUNTIME_DATABASE_OR_ISSUER_MISMATCH",
            )
            identities.append(values["DATABASE_URL"])
        r.require(
            identities[0] == identities[1],
            "IDENTITY_API_WORKER_DATABASE_CUSTODY_MISMATCH",
        )
        owner = urlsplit(custody["owner_uri"])
        r.require(
            owner.hostname == database["host"]
            and owner.path == "/" + database["database"]
            and owner.username == database["owner_role"]
            and database["owner_role"] != database["application_role"],
            "IDENTITY_OWNER_DATABASE_SCOPE",
        )
        databases.append((database["host"], database["database"]))
    r.require(
        databases[0] != databases[1], "IDENTITY_STAGING_DATABASE_MUST_BE_ISOLATED"
    )


def migration(binding, plan, env, operation, migrations, action, target):
    selected = plan["environments"][env]
    custody = json.loads(private_bytes(selected["database_file"]))
    exact(custody, ["database", "owner_uri"], "IDENTITY_DATABASE_CUSTODY_SCHEMA")
    runtime = selected["api"]["runtime_file"]
    private_bytes(runtime, runtime["path"])
    values = r.runtime_values(Path(runtime["path"]))
    request = {
        "action": action,
        "environment": env,
        "operation_id": operation,
        "source_commit": binding["candidate_commit"],
        "database": custody["database"],
        "owner_uri": custody["owner_uri"],
        "runtime_uri": values["DATABASE_URL"],
        "migrations": migrations,
    }
    program = Path(__file__).with_name("oracle_portal_identity_migrate.mjs").read_text()
    program += "\nimport fs from 'node:fs';try{console.log(JSON.stringify(await live(JSON.parse(fs.readFileSync(0,'utf8')))));}catch{console.log(JSON.stringify({state:'IDENTITY_MIGRATION_REFUSED_INSPECT_WITHOUT_RETRY'}));process.exitCode=1;}\n"
    row = json.loads(r.docker("inspect", TARGETS[env]["api"]))[0]
    network = list(row["NetworkSettings"]["Networks"])
    r.require(len(network) == 1, "IDENTITY_EXISTING_DATABASE_NETWORK_REQUIRED")
    intent = target / ("migration-" + action + ".intent.json")
    r.write(
        intent,
        {
            "binding": binding,
            "environment": env,
            "operation_id": operation,
            "action": action,
            "automatic_retry": False,
            "migrations": migrations,
        },
    )
    raw = r.docker(
        "run",
        "--rm",
        "-i",
        "--pull=never",
        "--network",
        network[0],
        "--read-only",
        "--memory",
        "256m",
        "--cpus",
        "0.1",
        "--pids-limit",
        "32",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--entrypoint",
        "node",
        binding["artifact_digest"],
        "--input-type=module",
        "-e",
        program,
        data=r.canonical(request),
        timeout=180,
    )
    result = json.loads(raw)
    r.require(
        result["source_commit"] == binding["candidate_commit"]
        and result["operation_id"] == operation
        and result["environment"] == env
        and result["state"]
        == (
            "IDENTITY_SCHEMA_014_APPLIED_NOT_AUTHORIZATION"
            if action == "apply"
            else "IDENTITY_SCHEMA_INSPECTED_NOT_AUTHORIZATION"
        )
        and result["credential_changes"] == 0
        and result["down_migrations"] == 0
        and result["existing_accounts_preserved"] is True
        and result["schema_version"]
        == (14 if action == "apply" else result["schema_version"]),
        "IDENTITY_MIGRATION_READBACK",
    )
    r.write(target / ("migration-" + action + ".json"), result)
    return result


def compose_change(
    binding, plan, env, kind, operation, target, values, *, rollback=False
):
    runtime = plan["environments"][env][kind]
    original = rendered(runtime, env, kind)
    service = env if kind == "api" else "worker"
    expected = json.loads(json.dumps(original))
    chosen = expected["services"][service]
    # Historical images cannot safely serialize accounts created with schema 013.
    # The qualified candidate itself is the fallback, with identity disabled.
    image = binding["artifact_digest"]
    labels = dict(chosen.get("labels") or {})
    labels.update(
        {
            "org.onesa.source-commit": binding["candidate_commit"],
            "org.onesa.release-operation": operation,
        }
    )
    environment = dict(chosen.get("environment") or {})
    r.require(
        not (IDENTITY_KEYS & set(environment)),
        "IDENTITY_BASELINE_MUST_BE_FEATURE_DISABLED",
    )
    if rollback:
        environment["ONESA_IDENTITY_ENABLED"] = "false"
    else:
        environment.update(values)
    chosen.update(image=image, labels=labels, environment=environment)
    override = target / (kind + "-override.json")
    r.write(
        override,
        {
            "services": {
                service: {"image": image, "labels": labels, "environment": environment}
            }
        },
    )
    r.require(
        rendered(runtime, env, kind, override) == expected,
        "IDENTITY_COMPOSE_WOULD_CHANGE_OTHER_CONFIGURATION",
    )
    r.write(
        target / (kind + "-intent.json"),
        {
            "binding": binding,
            "environment": env,
            "operation_id": operation,
            "rollback": rollback,
            "target": TARGETS[env][kind],
            "image_id": image,
            "override_sha256": r.sha(override),
            "request_budget": 1,
            "automatic_retry": False,
        },
    )
    try:
        result = subprocess.run(
            recipe_command(runtime, env, kind, override)
            + [
                "up",
                "--no-deps",
                "--no-build",
                "--pull",
                "never",
                "--wait",
                "--wait-timeout",
                "240",
                service,
            ],
            capture_output=True,
            timeout=300,
            check=False,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        )
    except subprocess.TimeoutExpired:
        r.write(
            target / (kind + "-result.json"),
            {"state": "TIMED_OUT_OUTCOME_UNCERTAIN", "automatic_retry": False},
        )
        raise r.Refused("IDENTITY_COMPOSE_INTERRUPTED_INSPECT_ONLY") from None
    # Provider output may contain private environment values; preserve only its
    # status/digests. No raw command output enters the release ledger.
    r.write(
        target / (kind + "-result.json"),
        {
            "returncode": result.returncode,
            "stdout_sha256": hashlib.sha256(result.stdout).hexdigest(),
            "stderr_sha256": hashlib.sha256(result.stderr).hexdigest(),
            "automatic_retry": False,
        },
    )
    r.require(result.returncode == 0, "IDENTITY_COMPOSE_FAILED_INSPECT_ONLY")
    row = json.loads(r.docker("inspect", TARGETS[env][kind]))[0]
    defaults = dict(
        v.split("=", 1)
        for v in json.loads(r.docker("image", "inspect", image))[0]["Config"]["Env"]
    )
    actual = dict(v.split("=", 1) for v in row["Config"]["Env"])
    r.require(
        row["Image"] == image
        and actual == {**defaults, **environment}
        and r.healthy(row)
        and row["Config"]["Labels"].get("org.onesa.release-operation") == operation
        and row["Config"]["Labels"].get("org.onesa.source-commit")
        == labels["org.onesa.source-commit"]
        and digest(stable_profile(row)) == runtime["profile_sha256"],
        "IDENTITY_RUNTIME_READBACK_FAILED",
    )
    return recovery_target(row)


def read_health(plan, env, enabled):
    origin = plan["environments"][env]["origins"]["portal"]
    fixtures = json.loads(private_bytes(plan["environments"][env]["browser_file"]))
    preview = fixtures.get("preview_sessions", {}).get("portal")
    r.require(
        not preview or preview["origin"] == origin, "IDENTITY_HEALTH_PREVIEW_ORIGIN"
    )
    bypass = preview["bypass_secret"] if preview else None
    for path in ["/api/v1/health", "/api/v1/ready"]:
        r.http_read(origin, path, 200, bypass)
    if enabled:
        value = r.http_read(origin, "/api/v1/account/config", 200, bypass)
        r.require(value.get("enabled") is True, "IDENTITY_CONFIG_NOT_ENABLED")
    else:
        value = r.http_read(origin, "/api/v1/account/config", 200, bypass)
        r.require(value.get("enabled") is False, "IDENTITY_CONFIG_NOT_DISABLED")
    return {"health": "PASS", "readiness": "PASS", "shared_identity_enabled": enabled}


def fixture_aliases(value, operation):
    """Expand only a reviewed mailbox alias, never select existing user data."""
    common.identifier(operation)
    result = json.loads(json.dumps(value))
    for role in ["member", "administrator"]:
        template = result["fixtures"][role]["email"]
        fragment = "onesa-acceptance-{operation_id}-" + role
        r.require(
            isinstance(template, str)
            and template.count("{operation_id}") == 1
            and template.count("@") == 1
            and fragment in template.split("@")[0]
            and "{operation_id}" not in template.split("@")[1],
            "IDENTITY_OPERATION_ALIAS_TEMPLATE_REQUIRED",
        )
        result["fixtures"][role]["email"] = template.replace(
            "{operation_id}", operation[:8]
        )
    return result


def verify_probe_image(plan):
    tool = r.trusted_toolchain(plan)
    source = r.private(Path(__file__).resolve().parent.parent / "tool-source.tar")
    r.require(
        r.sha(source) == tool["source_sha256"], "IDENTITY_PROBE_SOURCE_ARCHIVE_CHANGED"
    )
    _, files = r.source_inventory(source, {"source_tree": tool["source_tree"]})
    image = json.loads(r.docker("image", "inspect", tool["probe_image"]))[0]
    labels = image["Config"].get("Labels") or {}
    r.require(
        image["Id"] == tool["probe_image"]
        and image["Os"] == "linux"
        and image["Architecture"] == "arm64"
        and labels.get("org.opencontainers.image.revision") == tool["source_commit"]
        and labels.get("org.onesa.source-archive-sha256") == tool["source_sha256"],
        "IDENTITY_PROBE_IMAGE_SOURCE_CHANGED",
    )
    names = [
        "oracle_portal_identity_browser.mjs",
        "oracle_portal_identity_mail.mjs",
        "oracle_portal_browser_session.mjs",
    ]
    expected = {
        "/opt/onesa-company-portal/scripts/release/" + name: files[
            "scripts/release/" + name
        ]
        for name in names
    }
    output = r.docker(
        "run",
        "--rm",
        "--pull=never",
        "--network",
        "none",
        "--read-only",
        "--entrypoint",
        "sha256sum",
        image["Id"],
        *sorted(expected),
    )
    actual = {}
    for line in output.decode().splitlines():
        checksum, name = line.split("  ", 1)
        r.require(name not in actual, "IDENTITY_DUPLICATE_PROBE_MODULE")
        actual[name] = checksum
    r.require(actual == expected, "IDENTITY_PROBE_MODULE_CHANGED")
    return image["Id"]


def hosted(binding, plan, env, operation, target, *, scope="account"):
    r.require(scope in {"account", "integrated"}, "IDENTITY_HOSTED_SCOPE")
    selected = plan["environments"][env]
    fixtures = json.loads(private_bytes(selected["browser_file"]))
    exact(
        fixtures,
        ["fixtures", "preview_sessions"],
        "IDENTITY_PRIVATE_BROWSER_INPUT_SCHEMA",
    )
    fixtures = fixture_aliases(fixtures, operation)
    issuer = json.loads(private_bytes(selected["identity_file"]))
    exact(issuer, IDENTITY_KEYS, "IDENTITY_HOSTED_ISSUER_CONFIGURATION")
    r.require(
        issuer["ONESA_IDENTITY_ENABLED"] == "true", "IDENTITY_HOSTED_ISSUER_DISABLED"
    )
    registration = json.loads(
        base64.b64decode(issuer["ONESA_IDENTITY_CONFIG_B64"], validate=True)
    )
    clients = {value["product"]: value["clientId"] for value in registration["clients"]}
    r.require(
        len(registration["clients"]) == 3
        and set(clients) == {"ai", "drone", "robot"}
        and registration["issuer"] == selected["origins"]["portal"] + "/api/v1/identity"
        and fixtures["fixtures"].get("product_clients", clients) == clients,
        "IDENTITY_HOSTED_CLIENT_BINDING",
    )
    fixtures["fixtures"]["product_clients"] = clients
    request = {
        "schema_version": 1,
        "scope": scope,
        "binding": binding,
        "environment": env,
        "operation_id": operation,
        "origins": selected["origins"],
        **fixtures,
    }
    r.write(
        target / "hosted-intent.json",
        {
            "binding": binding,
            "environment": env,
            "operation_id": operation,
            "scope": scope,
            "request_budget": 1,
            "automatic_retry": False,
        },
    )
    program = Path(__file__).with_name("oracle_portal_identity_browser.mjs")
    pin_value = r.trusted_toolchain(plan)["workflow_files"][
        "scripts/release/" + program.name
    ]
    r.pinned_public_file(program, pin_value)
    image = verify_probe_image(plan)
    # The executable closure is read back from the actual immutable browser
    # image; provider bypass and fixture credentials travel only on private stdin.
    raw = r.docker(
        "run",
        "--rm",
        "-i",
        "--pull=never",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,size=256m",
        "--tmpfs",
        "/root:rw,nosuid,mode=700,size=32m",
        "--memory",
        "768m",
        "--cpus",
        "0.5",
        "--pids-limit",
        "128",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--entrypoint",
        "node",
        image,
        "/opt/onesa-company-portal/scripts/release/" + program.name,
        data=r.canonical(request),
        timeout=1250,
    )
    value = json.loads(raw)
    r.require(
        value["state"] == "HOSTED_IDENTITY_OBSERVED_NOT_AUTHORIZATION"
        and value["binding"] == binding
        and value["environment"] == env
        and value["operation_id"] == operation
        and value.get("physical_hardware_authorized") is False
        and value.get("physical_operations") == 0
        and value.get("synthetic_accounts_only") is True
        and value.get("fixture_accounts_disabled") is True,
        "IDENTITY_HOSTED_RECEIPT_SCOPE",
    )
    # The helper owns these actual browser observations. Unknown/missing checks
    # and caller-written PASS documents can never complete this path.
    r.require(
        set(value["checks"])
        == (HOSTED_CHECKS if scope == "integrated" else ACCOUNT_CHECKS)
        and value.get("scope") == scope
        and all(v is True for v in value["checks"].values()),
        "IDENTITY_HOSTED_ACCEPTANCE_INCOMPLETE",
    )
    r.write(target / "hosted.json", value)
    return value


@contextmanager
def component_lock():
    r.private(ROOT, directory=True)
    path = ROOT / "component.lock"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        r.private(path)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def reserve(parent, identifier, value):
    common.identifier(identifier)
    parent.mkdir(mode=0o700, exist_ok=True)
    r.private(parent, directory=True)
    target = parent / identifier
    r.require(not target.exists(), "IDENTITY_OPERATION_ALREADY_EXISTS_INSPECT_ONLY")
    target.mkdir(mode=0o700)
    r.write(target / "intent.json", value)
    return target


def stage_receipt(binding, records):
    contexts = [row for row in records if row["kind"] == "context"]
    r.require(len(contexts) == 1, "IDENTITY_SIGNED_CONTEXT_REQUIRED")
    path = ROOT / "observations" / contexts[0]["id"] / "receipt.json"
    value = r.read(path)
    r.require(
        value["binding"] == binding
        and value["state"] == "IDENTITY_STAGING_OBSERVED_NOT_AUTHORIZATION",
        "IDENTITY_STAGING_RECEIPT_MISSING",
    )
    for row in records:
        if row["kind"] == "qualification":
            r.require(
                row["details"]["staging"]["observations"]["receipt_sha256"]
                == r.sha(path),
                "IDENTITY_SIGNED_STAGING_RECEIPT_CHANGED",
            )
    return path, value


def staging(binding, plan, context, folder, records):
    with component_lock():
        common.capacity()
        preserved(plan)
        validate_custody(plan)
        migrations = source_and_image(binding, plan, folder)
        values = identity_values(binding, plan, "staging")
        # Validate production pairing/custody before touching the staging schema.
        identity_values(binding, plan, "production")
        operation = common.identifier(context["context_id"])
        target = reserve(
            ROOT / "observations",
            operation,
            {"binding": binding, "context_id": operation, "automatic_retry": False},
        )
        import oracle_portal_identity_restore as restore

        restored = restore.observe(binding, plan, operation, target / "restore")
        # Do not alter the live staging schema until a candidate-based fallback
        # has passed the full restored-data rehearsal, including member accounts.
        restore.verify_fallback(restored, binding)
        schema = migration(
            binding, plan, "staging", operation, migrations, "apply", target
        )
        scope = tuple(TARGETS["staging"].values())
        actual = {}
        # Exercise the already-qualified compatible fallback on staging, then
        # restore the candidate before the registration/mail workflow.
        for label, rollback in [
            ("forward", False),
            ("rollback", True),
            ("reapply", False),
        ]:
            step = target / label
            step.mkdir(mode=0o700)
            for kind in ["worker", "api"]:
                actual["portal-" + kind + "-staging"] = compose_change(
                    binding,
                    plan,
                    "staging",
                    kind,
                    operation,
                    step,
                    values,
                    rollback=rollback,
                )
                preserved(plan, scope)
            read_health(plan, "staging", not rollback)
        browser = hosted(binding, plan, "staging", operation, target)
        rows = preserved(plan, scope)
        r.require(
            all(r.healthy(rows[name]) for name in scope),
            "IDENTITY_STAGING_HEALTH_CHANGED",
        )
        value = {
            "state": "IDENTITY_STAGING_OBSERVED_NOT_AUTHORIZATION",
            "binding": binding,
            "context_id": operation,
            "migration": schema,
            "restore": restored,
            "hosted": browser,
            "runtime_targets": actual,
            "rollback": {
                "compatible_candidate_exercised": True,
                "additive_schema_retained": True,
                "credential_changes": 0,
                "down_migrations": 0,
            },
            "observed_at": r.now().isoformat(),
            "production_mutations": 0,
        }
        r.write(target / "receipt.json", value)
        return {
            "receipt_sha256": r.sha(target / "receipt.json"),
            "runtime_targets": actual,
            "receipt": value,
        }


def operations(binding, plan, records):
    _, stage = stage_receipt(binding, records)
    rows = preserved(plan, TARGETS["staging"].values())
    r.require(
        all(
            recovery_target(rows[name])
            == stage["runtime_targets"]["portal-" + kind + "-staging"]
            for kind, name in TARGETS["staging"].items()
        ),
        "IDENTITY_STAGING_ACCEPTANCE_STALE",
    )
    common.capacity()
    for timer in ["onesa-portal-backup.timer", "onesa-portal-monitor.timer"]:
        r.require(
            r.command(["/usr/bin/systemctl", "is-active", timer]).strip() == b"active",
            "IDENTITY_BACKUP_OR_MONITOR_INACTIVE",
        )
    import oracle_portal_identity_restore as restore

    restore.verify_retained(plan, stage["restore"])
    restore.verify_fallback(stage["restore"], binding)
    for env in ENVIRONMENTS:
        for name in TARGETS[env].values():
            old = plan["baseline"][name]["image"]
            r.require(
                json.loads(r.docker("image", "inspect", old))[0]["Id"] == old,
                "IDENTITY_RETAINED_ROLLBACK_IMAGE_MISSING",
            )
    return {
        "identity_restore": stage["restore"],
        "rollback": stage["rollback"],
        "privacy_decision": plan["privacy_decision"],
        "physical_hardware_authorized": False,
    }


def deploy(binding, plan, context, folder, records):
    with component_lock():
        operations(binding, plan, records)
        validate_custody(plan)
        migrations = source_and_image(binding, plan, folder)
        values = identity_values(binding, plan, "production")
        operation = common.identifier(context["operation_id"])
        target = reserve(
            ROOT / "deployments",
            operation,
            {
                "binding": binding,
                "context": context,
                "automatic_retry": False,
                "request_budget": 1,
            },
        )
        schema = migration(
            binding, plan, "production", operation, migrations, "apply", target
        )
        actual = {}
        for kind in ["worker", "api"]:
            actual["portal-" + kind + "-production"] = compose_change(
                binding, plan, "production", kind, operation, target, values
            )
            preserved(
                plan, [*TARGETS["staging"].values(), *TARGETS["production"].values()]
            )
        health = read_health(plan, "production", True)
        browser = hosted(binding, plan, "production", operation, target)
        value = {
            "state": "IDENTITY_PRODUCTION_DEPLOYED_NOT_AUTHORIZATION",
            "binding": binding,
            "operation_id": operation,
            "migration": schema,
            "hosted": browser,
            "health": health,
            "runtime_targets": actual,
            "observed_at": r.now().isoformat(),
            "physical_hardware_authorized": False,
        }
        r.write(target / "receipt.json", value)
        return {
            "operation_id": operation,
            "deployment_id": actual["portal-api-production"]["container_id"],
            "receipt_sha256": r.sha(target / "receipt.json"),
            "runtime_targets": actual,
            "receipt": value,
        }


def production(binding, plan, context, folder, records):
    # Inspection cannot resume compose, migration, registration, email or login.
    target = ROOT / "deployments" / common.identifier(context["operation_id"])
    intent = r.read(target / "intent.json")
    value = r.read(target / "receipt.json")
    r.require(
        intent["binding"] == value["binding"] == binding
        and value["operation_id"] == context["operation_id"]
        and value["state"] == "IDENTITY_PRODUCTION_DEPLOYED_NOT_AUTHORIZATION"
        and intent["request_budget"] == 1
        and intent["automatic_retry"] is False,
        "IDENTITY_COMPLETED_DEPLOYMENT_REQUIRED",
    )
    rows = preserved(
        plan, [*TARGETS["staging"].values(), *TARGETS["production"].values()]
    )
    _, stage = stage_receipt(binding, records)
    for env, expected in [("staging", stage), ("production", value)]:
        for kind, name in TARGETS[env].items():
            r.require(
                recovery_target(rows[name])
                == expected["runtime_targets"]["portal-" + kind + "-" + env]
                and rows[name]["Image"] == binding["artifact_digest"]
                and r.healthy(rows[name]),
                "IDENTITY_RUNTIME_ACCEPTANCE_CHANGED",
            )
    # The source/image and actual public routes are freshly re-observed. No
    # account-session or database-write helper runs in the read-only phase.
    source_and_image(binding, plan, folder)
    health = read_health(plan, "production", True)
    r.require(
        dt.timedelta()
        <= r.now() - dt.datetime.fromisoformat(value["observed_at"])
        < dt.timedelta(hours=1),
        "IDENTITY_HOSTED_ACCEPTANCE_EXPIRED",
    )
    return {
        "operation_id": context["operation_id"],
        "deployment_id": value["runtime_targets"]["portal-api-production"][
            "container_id"
        ],
        "receipt_sha256": r.sha(target / "receipt.json"),
        "runtime_targets": value["runtime_targets"],
        "health": health,
        "hosted": value["hosted"],
        "migration": value["migration"],
        "production_writes": 0,
        "physical_hardware_authorized": False,
    }


def runner(phase, binding, context):
    r.require(phase in CHECKS, "IDENTITY_PHASE_SCOPE")
    plan = r.read(PLAN)
    folder = validate_plan(binding, plan)
    records = r.verify_invocation(binding, context, phase, plan)
    if phase == "staging":
        observed = staging(binding, plan, context, folder, records)
    elif phase == "operations":
        observed = operations(binding, plan, records)
    elif phase == "deploy":
        observed = deploy(binding, plan, context, folder, records)
    else:
        observed = production(binding, plan, context, folder, records)
    return {
        **observed,
        "binding": binding,
        "environment": "staging" if phase == "staging" else "production",
        "workflow_run_id": 0,
        "observed_at": r.now().isoformat(),
        "checks": {key: "PASS" for key in CHECKS[phase]},
    }


def record_failure(phase, request, error, *, component="identity"):
    try:
        r.require(
            component in {"identity", "identity-acceptance"}
            and phase in CHECKS
            and isinstance(request, dict)
            and request["binding"]["component"] == component
            and request["binding"]["repository"] == common.REPOSITORY,
            "IDENTITY_DIAGNOSTIC_SCOPE",
        )
        root = r.private(ROOT.parent / component, directory=True)
        target = root / "failures"
        target.mkdir(mode=0o700, exist_ok=True)
        code = (
            str(error)
            if isinstance(error, r.Refused)
            and re.fullmatch(r"[A-Z0-9_]{1,120}", str(error))
            else type(error).__name__
        )
        r.write(
            target / (phase + "-" + str(time.time_ns()) + ".json"),
            {
                "source_commit": request["binding"]["candidate_commit"],
                "component": component,
                "phase": phase,
                "failure_code": code,
                "observed_at": r.now().isoformat(),
                "automatic_retry": False,
                "diagnostic_only_not_authorization": True,
            },
        )
    except (r.Refused, KeyError, TypeError, ValueError, OSError):
        pass


def main():
    request = None
    try:
        r.require(
            os.geteuid() == 0
            and os.getenv("SUDO_USER") == "ubuntu"
            and not os.getenv("GITHUB_ACTIONS"),
            "EXISTING_OWNER_SSH_REQUIRED",
        )
        r.require(len(sys.argv) == 2, "IDENTITY_PHASE_REQUIRED")
        raw = sys.stdin.buffer.read(131073)
        r.require(len(raw) <= 131072, "IDENTITY_REQUEST_BOUND")
        request = json.loads(raw)
        exact(request, ["binding", "context"], "IDENTITY_REQUEST_SCHEMA")
        print(
            json.dumps(
                runner(sys.argv[1], request["binding"], request["context"]),
                sort_keys=True,
            )
        )
    except Exception as error:
        record_failure(sys.argv[1] if len(sys.argv) == 2 else None, request, error)
        print(
            json.dumps({"state": "IDENTITY_OBSERVATION_FAILED_INSPECT_WITHOUT_RETRY"})
        )
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
