"""Read-only binding for an explicitly enrolled private Portal PostgreSQL target.

Absence of PROFILE retains the existing Neon backup path. A present, invalid
profile never falls back. Rendering emits a separate database-only Compose model;
it does not create a volume, initialize a cluster, change credentials or deploy it.
"""

import argparse
import base64
import copy
import hashlib
import json
import os
import re
import ssl
import stat
import subprocess
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit

PROFILE = Path("/etc/onesa/portal-database-target.json")
ROOT = Path(__file__).resolve().parents[3]
HEX = r"[a-f0-9]{64}"
UNSET = object()
DOCKER = ["/usr/bin/docker", "--host=unix:///var/run/docker.sock",
          "--config=/var/empty/onesa-database-target"]
PROCESS_ENV = {"PATH": "/usr/bin:/bin", "LANG": "C"}
DATABASE_COMMAND = [
    "-c", "ssl=on", "-c", "ssl_min_protocol_version=TLSv1.2",
    "-c", "ssl_cert_file=/run/onesa/server.crt", "-c", "ssl_key_file=/run/onesa/server.key",
    "-c", "hba_file=/run/onesa/pg_hba.conf", "-c", "shared_buffers=64MB",
    "-c", "max_connections=32",
]


def require(condition, code):
    if not condition:
        raise ValueError("PORTAL_DATABASE_" + code)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     allow_nan=False).encode()).hexdigest()


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "DUPLICATE_KEY")
        result[key] = value
    return result


def exact(value, keys, code):
    require(isinstance(value, dict) and set(value) == set(keys), code)


def pin(value):
    return isinstance(value, str) and re.fullmatch(HEX, value) is not None


def private_bytes(path, *, limit=65536, postgres_readable=False):
    path = Path(path)
    require(path.is_absolute() and ".." not in path.parts, "PRIVATE_PATH")
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                and info.st_mode & 0o022 == 0, "PRIVATE_PARENT")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o7000 == 0
                and info.st_nlink == 1 and 0 < info.st_size <= limit, "PRIVATE_FILE")
        if postgres_readable:
            # The unprivileged pinned PostgreSQL process reads these bind mounts.
            require(info.st_gid == 70 and info.st_mode & 0o077 == 0o040,
                    "POSTGRES_FILE_MODE")
        else:
            require(info.st_mode & 0o077 == 0, "PRIVATE_FILE_MODE")
        raw = os.read(fd, limit + 1)
        require(len(raw) == info.st_size and len(raw) <= limit, "PRIVATE_FILE_CHANGED")
        return raw
    finally:
        os.close(fd)


def validate(profile):
    exact(profile, ["schema_version", "environment", "database", "image", "volume",
                    "networks", "tls", "runtime_sha256", "container_id"], "PROFILE_SCHEMA")
    require(type(profile["schema_version"]) is int and profile["schema_version"] == 1,
            "PROFILE_VERSION")
    env = profile["environment"]
    require(env in ("production", "staging"), "ENVIRONMENT")
    db = profile["database"]
    exact(db, ["host", "port", "name", "application_role"], "TARGET_SCHEMA")
    require(db["host"] == "portal-postgres-" + env and type(db["port"]) is int
            and db["port"] == 5432 and isinstance(db["name"], str)
            and re.fullmatch(r"[a-z][a-z0-9_]{0,62}", db["name"])
            and db["application_role"] == "onesa_portal_app", "TARGET_IDENTITY")
    exact(profile["image"], ["reference", "id"], "IMAGE_SCHEMA")
    require(isinstance(profile["image"]["reference"], str)
            and re.fullmatch("postgres@sha256:" + HEX, profile["image"]["reference"])
            and isinstance(profile["image"]["id"], str)
            and re.fullmatch("sha256:" + HEX, profile["image"]["id"]), "IMAGE_PIN")
    exact(profile["volume"], ["name", "configuration_sha256"], "VOLUME_SCHEMA")
    require(profile["volume"]["name"] == "onesa-portal-postgres-" + env
            and pin(profile["volume"]["configuration_sha256"]), "VOLUME_PIN")
    exact(profile["networks"], ["api", "worker"], "NETWORKS_SCHEMA")
    for kind, name in (("api", "onesa-portal-oracle-api_" + env),
                       ("worker", "onesa-portal-oracle-" + env + "_worker_egress")):
        network = profile["networks"][kind]
        exact(network, ["name", "id"], "NETWORK_SCHEMA")
        require(network["name"] == name and pin(network["id"]), "NETWORK_PIN")
    require(profile["networks"]["api"]["id"] != profile["networks"]["worker"]["id"],
            "NETWORK_ISOLATION")
    exact(profile["tls"], ["ca", "certificate", "key", "hba"], "TLS_SCHEMA")
    paths = set()
    for item in profile["tls"].values():
        exact(item, ["path", "sha256"], "TLS_FILE_SCHEMA")
        require(isinstance(item["path"], str), "TLS_PATH")
        path = Path(item["path"])
        require(path.is_absolute() and str(path) == item["path"]
                and path.is_relative_to("/etc/onesa") and ".." not in path.parts
                and all(c not in item["path"] for c in "\r\n\x00,:")
                and pin(item["sha256"]) and item["path"] not in paths, "TLS_FILE_PIN")
        paths.add(item["path"])
    exact(profile["runtime_sha256"], ["api", "worker"], "RUNTIME_SCHEMA")
    require(all(pin(value) for value in profile["runtime_sha256"].values()), "RUNTIME_PIN")
    require(profile["container_id"] is None or pin(profile["container_id"]), "CONTAINER_PIN")
    return profile


def load(path=PROFILE, *, optional=True):
    path = Path(path)
    try:
        path.lstat()
    except FileNotFoundError:
        require(optional, "PROFILE_MISSING")
        return None
    return validate(json.loads(private_bytes(path), object_pairs_hook=unique))


def tls_files(profile):
    result = {}
    for name, item in profile["tls"].items():
        raw = private_bytes(item["path"], limit=16384, postgres_readable=name != "ca")
        require(hashlib.sha256(raw).hexdigest() == item["sha256"], "TLS_FILE_CHANGED")
        result[name] = raw
    ca = result["ca"].decode("ascii")
    require(len(result["ca"]) <= 8192 and ca.count("-----BEGIN CERTIFICATE-----") == 1
            and ca.count("-----END CERTIFICATE-----") == 1, "CA_FORMAT")
    try:
        ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT).load_verify_locations(cadata=ca)
    except (ValueError, ssl.SSLError):
        raise ValueError("PORTAL_DATABASE_CA_FORMAT") from None
    rules = [line.split("#", 1)[0].split() for line in result["hba"].decode("ascii").splitlines()]
    rules = [rule for rule in rules if rule]
    require(rules and any(rule[0] == "hostssl" and rule[-1] == "scram-sha-256" for rule in rules),
            "HBA_TLS_REQUIRED")
    for rule in rules:
        require((len(rule) == 5 and rule[0] == "hostssl" and rule[-1] in ("scram-sha-256", "reject"))
                or (len(rule) == 5 and rule[0] == "hostnossl" and rule[-1] == "reject")
                or (len(rule) == 4 and rule[0] == "local" and rule[-1] in ("peer", "scram-sha-256", "reject")),
                "HBA_TLS_REQUIRED")
    return result


def runtime_paths(environment):
    return {"api": Path("/etc/onesa/backends/portal-" + environment + ".env"),
            "worker": Path("/etc/onesa/portal-" + environment + ".env")}


def checked_runtime(profile, path):
    """Check both writers and the CA, returning only the selected private env."""
    validate(profile)
    require(profile["environment"] == "production" and Path(path) == runtime_paths("production")["worker"],
            "BACKUP_SCOPE")
    ca = tls_files(profile)["ca"]
    selected, uris = None, []
    for kind, runtime in runtime_paths("production").items():
        raw = private_bytes(runtime)
        require(hashlib.sha256(raw).hexdigest() == profile["runtime_sha256"][kind], "RUNTIME_CHANGED")
        values = unique(line.split("=", 1) for line in raw.decode().splitlines()
                        if line and not line.startswith("#") and "=" in line)
        uri = urlsplit(values.get("DATABASE_URL", ""))
        db = profile["database"]
        require(uri.scheme in ("postgres", "postgresql") and uri.hostname == db["host"]
                and (uri.port or 5432) == db["port"] and uri.path == "/" + db["name"]
                and uri.username == db["application_role"] and uri.password and not uri.fragment
                and parse_qsl(uri.query, keep_blank_values=True) == [("sslmode", "verify-full")]
                and values.get("ONESA_DATABASE_CA_PEM_B64") == base64.b64encode(ca).decode(),
                "RUNTIME_TARGET_MISMATCH")
        require(not any(c in unquote(uri.password) for c in "\r\n\x00"), "CREDENTIAL_FORMAT")
        uris.append(values["DATABASE_URL"])
        if kind == "worker":
            selected = values, uri
    require(uris[0] == uris[1], "API_WORKER_TARGET_MISMATCH")
    return selected


def inspect(kind, identity):
    # Read-only local daemon inspection; no ambient remote Docker context.
    result = subprocess.run(
        [*DOCKER, kind, "inspect", identity], env=PROCESS_ENV,
        capture_output=True, timeout=15, check=False)
    require(result.returncode == 0 and len(result.stdout) <= 1024 * 1024, "INSPECTION_FAILED")
    rows = json.loads(result.stdout, object_pairs_hook=unique)
    require(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict), "INSPECTION_SHAPE")
    return rows[0]


def volume_identity(row):
    return {key: row.get(key) for key in ("Name", "Driver", "Scope", "Mountpoint",
                                         "CreatedAt", "Labels", "Options")}


def resources(profile):
    validate(profile)
    image = inspect("image", profile["image"]["reference"])
    require(image["Id"] == profile["image"]["id"] and image["Architecture"] == "arm64"
            and image["Os"] == "linux" and profile["image"]["reference"] in (image.get("RepoDigests") or []),
            "IMAGE_CHANGED")
    volume = inspect("volume", profile["volume"]["name"])
    require(volume["Name"] == profile["volume"]["name"] and volume["Driver"] == "local"
            and volume["Scope"] == "local" and not volume.get("Options")
            and digest(volume_identity(volume)) == profile["volume"]["configuration_sha256"],
            "VOLUME_CHANGED")
    for target in profile["networks"].values():
        network = inspect("network", target["id"])
        require(network["Id"] == target["id"] and network["Name"] == target["name"]
                and network["Driver"] == "bridge" and network["Scope"] == "local", "NETWORK_CHANGED")
    return volume


def compose(profile):
    """Only caller-selected preparation uses the ignored extension, never app up."""
    validate(profile)
    source = json.loads((ROOT / "compose.oracle-backend.yaml").read_text())
    model = copy.deepcopy(source["x-portal-container-primary"])
    env = profile["environment"]
    model["name"] = "onesa-portal-oracle-database-" + env
    service = model["services"]["primary"]
    require(service["command"] == DATABASE_COMMAND, "COMPOSE_DATABASE_COMMAND_CHANGED")
    service["image"] = profile["image"]["reference"]
    service["container_name"] = "onesa-portal-postgres-" + env
    service["labels"]["org.onesa.environment"] = env
    for kind, target in profile["networks"].items():
        model["networks"][kind]["name"] = target["name"]
        service["networks"][kind]["aliases"] = [profile["database"]["host"]]
    model["volumes"]["data"]["name"] = profile["volume"]["name"]
    for name, target in (("certificate", "/run/onesa/server.crt"),
                         ("key", "/run/onesa/server.key"), ("hba", "/run/onesa/pg_hba.conf")):
        service["volumes"].append({"type": "bind", "source": profile["tls"][name]["path"],
                                   "target": target, "read_only": True,
                                   "bind": {"create_host_path": False}})
    return model


def backup_binding(profile):
    """Observe the enrolled primary; this never starts or promotes a database."""
    validate(profile)
    require(profile["environment"] == "production" and pin(profile["container_id"]), "PRIMARY_NOT_ENROLLED")
    ca = tls_files(profile)["ca"]
    volume = resources(profile)
    row = inspect("container", profile["container_id"])
    host, config = row["HostConfig"], row["Config"]
    require(row["Id"] == profile["container_id"]
            and row["Name"] == "/onesa-portal-postgres-" + profile["environment"]
            and row["Image"] == profile["image"]["id"] and config["Image"] == profile["image"]["reference"]
            and config["User"] == "70:70" and config["Entrypoint"] == ["postgres"]
            and config["Cmd"] == DATABASE_COMMAND
            and [item for item in config.get("Env", []) if item.startswith("PGDATA=")]
            == ["PGDATA=/var/lib/postgresql/data"]
            and row["State"].get("Running") is True
            and row["State"].get("Paused") is False and row["State"].get("Restarting") is False,
            "PRIMARY_CHANGED")
    require(not host.get("PortBindings") and not host.get("PublishAllPorts")
            and host.get("NetworkMode") != "host" and host.get("Privileged") is False
            and host.get("ReadonlyRootfs") is True and host.get("CapDrop") == ["ALL"]
            and not host.get("CapAdd") and "no-new-privileges:true" in (host.get("SecurityOpt") or []),
            "PRIMARY_EXPOSURE")
    networks = row["NetworkSettings"]["Networks"]
    require(set(networks) == {value["name"] for value in profile["networks"].values()}, "PRIMARY_NETWORKS")
    for target in profile["networks"].values():
        require(networks[target["name"]]["NetworkID"] == target["id"]
                and profile["database"]["host"] in (networks[target["name"]].get("Aliases") or []),
                "PRIMARY_NETWORK_CHANGED")
    mounts = {entry["Destination"]: entry for entry in row["Mounts"]}
    expected = {"/var/lib/postgresql/data", "/run/onesa/server.crt", "/run/onesa/server.key",
                "/run/onesa/pg_hba.conf"}
    require(set(mounts) == expected, "PRIMARY_MOUNTS")
    data = mounts["/var/lib/postgresql/data"]
    require(data["Type"] == "volume" and data["Name"] == profile["volume"]["name"]
            and data["Source"] == volume["Mountpoint"] and data["RW"] is True, "PRIMARY_VOLUME_CHANGED")
    for name, destination in (("certificate", "/run/onesa/server.crt"), ("key", "/run/onesa/server.key"),
                              ("hba", "/run/onesa/pg_hba.conf")):
        mount = mounts[destination]
        require(mount["Type"] == "bind" and mount["Source"] == profile["tls"][name]["path"]
                and mount["RW"] is False, "PRIMARY_TLS_MOUNT_CHANGED")
    return {"network_id": profile["networks"]["worker"]["id"], "ca": ca,
            "profile_sha256": digest(profile)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("render", "check"))
    parser.add_argument("--profile", type=Path, default=PROFILE)
    args = parser.parse_args()
    require(os.geteuid() == 0, "ROOT_REQUIRED")
    profile = load(args.profile, optional=False)
    if args.action == "render":
        tls_files(profile)
        resources(profile)
        print(json.dumps(compose(profile), indent=2))
    else:
        checked_runtime(profile, runtime_paths("production")["worker"])
        observed = backup_binding(profile)
        print(json.dumps({"state": "TARGET_METADATA_OBSERVED_NOT_DEPLOYMENT_ACCEPTANCE",
                          "profile_sha256": observed["profile_sha256"]}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, KeyError, OSError, subprocess.SubprocessError):
        raise SystemExit("Portal database target refused; private review required") from None
