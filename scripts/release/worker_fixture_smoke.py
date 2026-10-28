"""Credential-free worker fixture proof on disposable local PostgreSQL only.

No application environment, provider credential, published port or hosted record
is used. The strict Neon hostname is an alias on a fresh internal test network;
its synthetic CA and password exist only in this test's private temporary files.
"""

import argparse
import hashlib
import json
import os
import re
import secrets
import subprocess
import tempfile
import time
from pathlib import Path
from uuid import uuid4

POSTGRES = (
    "postgres@sha256:2ad58d61b036d41f2613302e8c0fee03f6fe51e94d68087327ac45d1cebd4b5e"
)
HOST = "ep-morning-shadow-b9jkzgsz.c-7.eu-central-1.aws.neon.tech"
FILES = [
    "oracle_portal_worker_fixture.mjs",
    "oracle_portal_worker_fixture.integration.mjs",
]


def execute(arguments, **kwargs):
    return subprocess.run(arguments, capture_output=True, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "image", help="Existing credential-free backend Docker image ID"
    )
    parser.add_argument("--worker-workflows", action="store_true")
    parser.add_argument("--synthetic-scanner", action="store_true")
    parser.add_argument(
        "--scanner-socket-volume",
        help="Existing scanner socket volume, mounted read-only for synthetic bytes",
    )
    args = parser.parse_args()
    assert re.fullmatch(r"sha256:[a-f0-9]{64}", args.image), (
        "Immutable local image required"
    )
    docker = "docker"
    assert args.worker_workflows == bool(
        args.scanner_socket_volume or args.synthetic_scanner
    )
    assert not (args.scanner_socket_volume and args.synthetic_scanner)
    if args.scanner_socket_volume:
        assert re.fullmatch(
            r"[a-z0-9][a-z0-9_-]{0,127}_scanner_socket", args.scanner_socket_volume
        )
    operation = str(uuid4())
    label = "org.onesa.worker-fixture-test=" + operation
    name = "onesa-worker-fixture-" + operation
    network = name + "-network"
    source = Path(__file__).resolve().parent
    files = list(FILES)
    if args.worker_workflows:
        files += [
            "oracle_portal_worker_probe.mjs",
            "oracle_portal_worker_smtp.mjs",
            "oracle_portal_worker_workflows.integration.mjs",
        ]
    pins = {n: hashlib.sha256((source / n).read_bytes()).hexdigest() for n in files}
    postgres_id = json.loads(execute([docker, "image", "inspect", POSTGRES]).stdout)[0][
        "Id"
    ]
    assert (
        json.loads(execute([docker, "image", "inspect", args.image]).stdout)[0]["Id"]
        == args.image
    )
    created_network = False
    created_container = False
    with tempfile.TemporaryDirectory(prefix="onesa-worker-fixture-test-") as folder:
        root = Path(folder)
        root.chmod(0o700)
        password = "onesa_local_test_" + secrets.token_hex(24)
        env = root / "postgres.env"
        env.write_text(
            "POSTGRES_USER=fixture_admin\nPOSTGRES_DB=neondb\nPOSTGRES_PASSWORD="
            + password
            + "\n"
        )
        env.chmod(0o600)
        execute(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-subj",
                "/CN=" + HOST,
                "-addext",
                "subjectAltName=DNS:"
                + HOST
                + ",DNS:fixture-storage.invalid,IP:127.0.0.1",
                "-keyout",
                str(root / "server.key"),
                "-out",
                str(root / "server.crt"),
            ]
        )
        (root / "server.key").chmod(0o600)
        (root / "server.crt").chmod(0o644)
        if args.worker_workflows:
            assert os.geteuid() == 0, (
                "Linux owner fixture only; no privileged daemon client in the application"
            )
            for tls_name in ["server.key", "server.crt"]:
                os.chown(root / tls_name, 1000, 1000)
                (root / tls_name).chmod(0o600)
        try:
            execute(
                [
                    docker,
                    "network",
                    "create",
                    "--driver",
                    "bridge",
                    "--internal",
                    "--label",
                    label,
                    network,
                ]
            )
            created_network = True
            inspected = json.loads(
                execute([docker, "network", "inspect", network]).stdout
            )[0]
            assert inspected["Internal"] is True and inspected["Driver"] == "bridge"
            assert inspected["Labels"]["org.onesa.worker-fixture-test"] == operation
            # Linux bind mounts retain the host's private directory ownership.
            # Copy both files before dropping to postgres; do not expose/chmod
            # the host directory merely to let the daemon traverse it.
            command = "cp /fixture/server.key /tmp/server.key && cp /fixture/server.crt /tmp/server.crt && chown postgres:postgres /tmp/server.key /tmp/server.crt && chmod 600 /tmp/server.key && chmod 644 /tmp/server.crt && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key"
            execute(
                [
                    docker,
                    "run",
                    "-d",
                    "--pull=never",
                    "--name",
                    name,
                    "--label",
                    label,
                    "--network",
                    network,
                    "--network-alias",
                    HOST,
                    "--memory",
                    "256m",
                    "--cpus",
                    "0.25",
                    "--env-file",
                    str(env),
                    "--tmpfs",
                    "/var/lib/postgresql/data:rw,mode=700,size=256m",
                    "--tmpfs",
                    "/tmp:rw,mode=1777,size=16m",
                    "-v",
                    str(root) + ":/fixture:ro",
                    "--entrypoint",
                    "sh",
                    postgres_id,
                    "-c",
                    command,
                ]
            )
            created_container = True
            deadline = time.monotonic() + 60
            while True:
                ready = subprocess.run(
                    [
                        docker,
                        "exec",
                        name,
                        "pg_isready",
                        "-h",
                        "127.0.0.1",
                        "-U",
                        "fixture_admin",
                        "-d",
                        "neondb",
                    ],
                    capture_output=True,
                    check=False,
                )
                if ready.returncode == 0:
                    break
                state = json.loads(execute([docker, "inspect", name]).stdout)[0][
                    "State"
                ]
                if not state["Running"]:
                    logs = subprocess.run(
                        [docker, "logs", name], capture_output=True, check=False
                    )
                    text = (logs.stdout + logs.stderr).decode(errors="replace")
                    print(
                        json.dumps(
                            {
                                "state": "LOCAL_FIXTURE_POSTGRES_STARTUP_FAILED",
                                "exit_code": state["ExitCode"],
                                "certificate_access_error": "could not load server certificate"
                                in text
                                or "Permission denied" in text,
                                "private_log_contents_printed": False,
                            }
                        )
                    )
                    raise RuntimeError(
                        "Disposable PostgreSQL exited; inspect fixed diagnostics"
                    )
                assert time.monotonic() < deadline, (
                    "Disposable PostgreSQL did not start"
                )
                time.sleep(0.5)
            assert not json.loads(execute([docker, "inspect", name]).stdout)[0][
                "HostConfig"
            ]["PortBindings"], "Test ports must remain unpublished"
            # Match the hosted owner privileges. Superuser-only fixtures hide
            # missing SET/INHERIT membership when a role creator owns a new DB.
            execute(
                [
                    docker,
                    "exec",
                    "-i",
                    name,
                    "psql",
                    "-U",
                    "fixture_admin",
                    "-d",
                    "neondb",
                    "--no-psqlrc",
                    "-q",
                    "-v",
                    "ON_ERROR_STOP=1",
                ],
                input=(
                    "CREATE ROLE neondb_owner LOGIN NOSUPERUSER CREATEDB CREATEROLE "
                    "NOREPLICATION NOBYPASSRLS PASSWORD '" + password + "';\n"
                    "ALTER DATABASE neondb OWNER TO neondb_owner;\n"
                ).encode(),
                timeout=15,
            )
            mounts = [
                part
                for n in files
                for part in ["-v", str(source / n) + ":/app/release/" + n + ":ro"]
            ]
            extra = []
            if args.worker_workflows:
                extra = [
                    "--group-add",
                    "3000",
                    "--add-host",
                    "fixture-storage.invalid:127.0.0.1",
                    "--tmpfs",
                    "/private:rw,mode=700,uid=1000,gid=1000,size=8m",
                    "-v",
                    str(root / "server.crt") + ":/private/tls/cert.pem:ro",
                    "-v",
                    str(root / "server.key") + ":/private/tls/key.pem:ro",
                ]
                if args.synthetic_scanner:
                    extra += [
                        "--tmpfs",
                        "/run/onesa-scanner:rw,mode=700,uid=1000,gid=1000,size=1m",
                    ]
                else:
                    extra += [
                        "-v",
                        args.scanner_socket_volume + ":/run/onesa-scanner:ro",
                    ]
            entry = (
                "oracle_portal_worker_workflows.integration.mjs"
                if args.worker_workflows
                else "oracle_portal_worker_fixture.integration.mjs"
            )
            result = execute(
                [
                    docker,
                    "run",
                    "--rm",
                    "--pull=never",
                    "--name",
                    name + "-client",
                    "--label",
                    label,
                    "-i",
                    "--user",
                    "1000:1000" if args.worker_workflows else "0:0",
                    "--read-only",
                    "--network",
                    network,
                    "--tmpfs",
                    "/tmp:rw,mode=700,uid=1000,gid=1000,size=64m"
                    if args.worker_workflows
                    else "/tmp:rw,mode=700,size=64m",
                    "--memory",
                    "768m" if args.worker_workflows else "512m",
                    "--cpus",
                    "0.25",
                    "--cap-drop",
                    "ALL",
                    "--security-opt",
                    "no-new-privileges:true",
                    "-e",
                    "NODE_EXTRA_CA_CERTS=/private/tls/cert.pem"
                    if args.worker_workflows
                    else "NODE_EXTRA_CA_CERTS=/fixture/server.crt",
                    "-v",
                    str(root / "server.crt") + ":/fixture/server.crt:ro",
                    *mounts,
                    *extra,
                    "--entrypoint",
                    "node",
                    args.image,
                    "/app/release/" + entry,
                ],
                input=json.dumps(
                    {
                        "scope": "LOCAL_DISPOSABLE_WORKER_WORKFLOWS_ONLY"
                        if args.worker_workflows
                        else "LOCAL_DISPOSABLE_POSTGRES17_TLS_ONLY",
                        "owner_uri": "postgresql://neondb_owner:"
                        + password
                        + "@"
                        + HOST
                        + "/neondb?sslmode=verify-full&channel_binding=require",
                        **(
                            {"synthetic_scanner": args.synthetic_scanner}
                            if args.worker_workflows
                            else {}
                        ),
                    }
                ).encode(),
                timeout=300 if args.worker_workflows else 180,
            )
            observed = json.loads(result.stdout)
            assert observed["state"] == (
                "LOCAL_WORKER_PROCESS_WORKFLOWS_PASS_NOT_HOSTED_QUALIFICATION"
                if args.worker_workflows
                else "LOCAL_WORKER_FIXTURE_POSTGRES17_TLS_PASS_NOT_HOSTED_QUALIFICATION"
            )
            assert (
                observed["production_access"] is False
                and observed["release_records_issued"] == 0
            )
            assert (
                len(observed["checks"]) >= 17
                if args.worker_workflows
                else len(observed["checks"]) == 7
            )
            assert not result.stderr
            assert pins == {
                n: hashlib.sha256((source / n).read_bytes()).hexdigest() for n in files
            }
            print(
                json.dumps(
                    {
                        **observed,
                        "application_image": args.image,
                        "postgres_image": postgres_id,
                        "source_files_sha256": pins,
                    }
                )
            )
        except subprocess.CalledProcessError as error:
            # The child test emits fixed diagnostics; never print connection input.
            raise RuntimeError(
                "Disposable fixture test command failed; no credential values printed"
            ) from error
        finally:
            client = subprocess.run(
                [docker, "inspect", name + "-client"], capture_output=True, check=False
            )
            if client.returncode == 0:
                own = json.loads(client.stdout)[0]
                assert (
                    own["Config"]["Labels"]["org.onesa.worker-fixture-test"]
                    == operation
                )
                execute([docker, "rm", "-f", name + "-client"])
            if created_container:
                own = json.loads(execute([docker, "inspect", name]).stdout)[0]
                assert (
                    own["Config"]["Labels"]["org.onesa.worker-fixture-test"]
                    == operation
                )
                execute([docker, "rm", "-f", name])
            if created_network:
                own = json.loads(
                    execute([docker, "network", "inspect", network]).stdout
                )[0]
                assert own["Labels"]["org.onesa.worker-fixture-test"] == operation
                execute([docker, "network", "rm", network])


if __name__ == "__main__":
    main()
