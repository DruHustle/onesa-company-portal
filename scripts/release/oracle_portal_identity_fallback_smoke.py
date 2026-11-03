"""Exercise the compatible fallback using an offline synthetic restored database.

This test uses the caller's existing immutable candidate image and an existing
pinned PostgreSQL image. It creates no host ports, host data mounts or credentials.
The named containers are owned by this invocation and checked before removal.
"""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import oracle_portal as r
import oracle_portal_identity_restore as restore

POSTGRES = (
    "postgres@sha256:2ad58d61b036d41f2613302e8c0fee03f6fe51e94d68087327ac45d1cebd4b5e"
)
ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="Already built immutable candidate image ID")
    args = parser.parse_args()
    r.require(re.fullmatch(r"sha256:[a-f0-9]{64}", args.image), "CANDIDATE_IMAGE_ID")
    docker = shutil.which("docker")
    r.require(docker is not None, "DOCKER_REQUIRED")
    original = subprocess.run

    def execute(arguments, *, data=None, timeout=120):
        result = original(
            [docker, *arguments],
            input=data,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        r.require(result.returncode == 0, "SYNTHETIC_FIXTURE_COMMAND_FAILED")
        return result.stdout

    def routed(arguments, **kwargs):
        arguments = list(arguments)
        if arguments and arguments[0] == "/usr/bin/docker":
            arguments[0] = docker
        return original(arguments, **kwargs)

    def fixture_docker(*arguments, **kwargs):
        return execute(
            arguments, data=kwargs.get("data"), timeout=kwargs.get("timeout", 120)
        )

    image = json.loads(execute(["image", "inspect", args.image]))[0]
    r.require(image["Id"] == args.image, "CANDIDATE_IMAGE_CHANGED")
    postgres = json.loads(execute(["image", "inspect", POSTGRES]))[0]["Id"]
    operation = str(uuid4())
    operation_key = operation.replace("-", "")
    fixture_label = "org.onesa.identity-fallback-fixture=" + operation
    source_name = "onesa-fallback-source-" + operation_key
    restore_name = "onesa-isolated-portal-restore-" + operation_key
    created = []

    def create(name, database, extra_labels=()):
        identifier = (
            execute(
                [
                    "run",
                    "-d",
                    "--name",
                    name,
                    "--network",
                    "none",
                    "--pull=never",
                    "--tmpfs",
                    "/var/lib/postgresql/data:rw,size=512m",
                    "--label",
                    fixture_label,
                    *[arg for label in extra_labels for arg in ("--label", label)],
                    "--env",
                    "POSTGRES_HOST_AUTH_METHOD=trust",
                    "--env",
                    "POSTGRES_DB=" + database,
                    postgres,
                ]
            )
            .decode()
            .strip()
        )
        r.require(re.fullmatch(r"[a-f0-9]{64}", identifier), "SYNTHETIC_CONTAINER_ID")
        created.append((name, identifier))
        item = json.loads(execute(["inspect", identifier]))[0]
        labels = item["Config"].get("Labels") or {}
        r.require(
            item["Id"] == identifier
            and item["Name"] == "/" + name
            and item["Image"] == postgres
            and item["HostConfig"]["NetworkMode"] == "none"
            and not item["HostConfig"].get("PortBindings")
            and all(mount.get("Type") == "tmpfs" for mount in item.get("Mounts", []))
            and labels.get("org.onesa.identity-fallback-fixture") == operation,
            "SYNTHETIC_CONTAINER_ISOLATION",
        )
        restore.wait_for_restore(identifier, database)
        return identifier

    def psql(container, database, statement):
        return execute(
            [
                "exec",
                "-i",
                container,
                "psql",
                "-U",
                "postgres",
                "-d",
                database,
                "-XqAt",
                "-v",
                "ON_ERROR_STOP=1",
            ],
            data=statement,
        )

    with (
        patch.object(restore.subprocess, "run", side_effect=routed),
        patch.object(r, "docker", side_effect=fixture_docker),
    ):
        try:
            source = create(source_name, "onesa_fixture_source")
            psql(
                source,
                "onesa_fixture_source",
                b"CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL);",
            )
            for migration in sorted(
                (ROOT / "onesa-company-portal-backend/migrations").glob("*.sql")
            ):
                data = migration.read_bytes()
                query = (
                    b"BEGIN;\n"
                    + data
                    + (
                        f"\nINSERT INTO schema_migrations VALUES ('{migration.name}','{hashlib.sha256(data).hexdigest()}');\nCOMMIT;\n"
                    ).encode()
                )
                psql(source, "onesa_fixture_source", query)
            member = str(uuid4())
            psql(
                source,
                "onesa_fixture_source",
                (
                    "INSERT INTO users(id,email,password_hash,role) VALUES ('"
                    + member
                    + "','restored-member@example.invalid','synthetic','member');"
                    "INSERT INTO identity_profiles(user_id,display_name,email_verified_at) VALUES ('"
                    + member
                    + "','Restored fixture',now());"
                    "INSERT INTO identity_product_access(user_id,product,role,status) VALUES ('"
                    + member
                    + "','ai','user','active');"
                ).encode(),
            )
            dump = execute(
                [
                    "exec",
                    source,
                    "pg_dump",
                    "-U",
                    "postgres",
                    "-d",
                    "onesa_fixture_source",
                    "-Fc",
                ]
            )
            snapshot = hashlib.sha256(dump).hexdigest()
            target = create(
                restore_name,
                "onesa_identity_restore",
                [
                    "org.onesa.restore-scope=isolated",
                    "org.onesa.product=portal",
                    "org.onesa.restore-snapshot-sha256=" + snapshot,
                ],
            )
            execute(
                [
                    "exec",
                    "-i",
                    target,
                    "pg_restore",
                    "--no-owner",
                    "--no-acl",
                    "--exit-on-error",
                    "-U",
                    "postgres",
                    "-d",
                    "onesa_identity_restore",
                ],
                data=dump,
            )
            result = restore.fallback_observe(
                {"artifact_digest": args.image, "candidate_commit": "a" * 40},
                operation,
                restore_name,
                target,
                "onesa_identity_restore",
                {"source_backup_sha256": snapshot},
            )
            restore.verify_fallback(
                {"compatible_fallback": result},
                {"artifact_digest": args.image, "candidate_commit": "a" * 40},
            )
            count = psql(
                target,
                "onesa_identity_restore",
                (
                    "SELECT count(*) FROM users u JOIN identity_product_access p ON p.user_id=u.id "
                    "WHERE u.id='"
                    + member
                    + "' AND u.role='member' AND p.product='ai' AND p.status='active';"
                ).encode(),
            ).strip()
            r.require(count == b"1", "RESTORED_SYNTHETIC_MEMBER_CHANGED")
        finally:
            for name, identifier in reversed(created):
                item = json.loads(execute(["inspect", identifier]))[0]
                labels = item["Config"].get("Labels") or {}
                r.require(
                    item["Id"] == identifier
                    and item["Name"] == "/" + name
                    and labels.get("org.onesa.identity-fallback-fixture") == operation,
                    "SYNTHETIC_CLEANUP_OWNERSHIP",
                )
                execute(["rm", "-f", identifier])
                restore.verify_container_removed(identifier)
    print(
        json.dumps(
            {
                "state": "SYNTHETIC_OFFLINE_FALLBACK_PASSED",
                "image": args.image,
                "restored_member_preserved": True,
                "operation_containers_removed": True,
            }
        )
    )


if __name__ == "__main__":
    main()
