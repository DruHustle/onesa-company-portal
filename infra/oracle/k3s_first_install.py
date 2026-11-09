#!/usr/bin/env python3
"""Owner-run, single-node first install; never an OCI resize or app migration.

No action is performed on import. check is read-only. install requires a private
root-owned plan, selected OCI IMDSv2 identity, verified release artifacts, an
unoccupied cluster boundary and the existing reviewed Onesa Docker firewall.
An interrupted receipt cannot be reused. recover stops only this receipt's unit,
retains all data and private rules, and requires an operator review before reuse.
"""

import argparse
import copy
import datetime as dt
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import time
import types
import urllib.request
from uuid import uuid4

import kubernetes_preflight as preflight
import portainer_private as portainer


Refused = preflight.Refused
require = preflight.require
STATE = Path("/var/lib/onesa-kubernetes")
RECEIPT = STATE / "installation.json"
CONFIG_DIR = Path("/etc/rancher/k3s")
CONFIG = CONFIG_DIR / "config.yaml"
KUBECONFIG = CONFIG_DIR / "k3s.yaml"
DATA = Path("/var/lib/rancher/k3s")
LIB = Path("/usr/local/lib/onesa-kubernetes")
BINARY = Path("/usr/local/bin/k3s")
UNIT_DIR = Path("/etc/systemd/system")
UNIT = "onesa-k3s.service"
FIREWALL_UNIT = "onesa-k3s-firewall.service"
INPUT_CHAIN = "ONESA_K3S_INPUT"
FORWARD_CHAIN = "ONESA_K3S_FORWARD"
NATIVE_TABLE = "onesa_k3s"
LOCK = Path("/var/lib/onesa/runtime-recovery/kubernetes-install.lock")
STORAGE_CLASS = "onesa-portainer-retain"
VOLUME = "onesa-portainer-local"
MAX_OUTPUT = 4 * 1024 * 1024
ROOT_UID = 0
SOURCE_FILES = ("k3s_first_install.py", "kubernetes_preflight.py", "portainer_private.py", "k3s_release_lock.json")
LEASE_KIND = "owner-kubernetes-first-install"
LEASE_SCOPE = "OnesaUGBackend:kubernetes"
PLAN_KEYS = {"instance_id", "machine_id_sha256", "private_ip", "pod_cidr", "service_cidr",
             "reserved_cidrs", "dns_upstream_ipv4", "workload_memory_mib", "workload_disk_gib"}


def digest(value):
    return hashlib.sha256(value).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def file_digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as source:
        while chunk := source.read(1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


def run(args, *, input_bytes=None, timeout=20, allow_failure=False):
    """Fixed argv, no shell, inherited credentials or raw diagnostic output."""
    executable = shutil.which(args[0], path=preflight.SAFE_PATH)
    require(executable is not None, "REQUIRED_HOST_COMMAND_UNAVAILABLE")
    try:
        result = subprocess.run([executable, *map(str, args[1:])], input=input_bytes,
                                capture_output=True, timeout=timeout, check=False,
                                env={"PATH": preflight.SAFE_PATH, "LANG": "C", "LC_ALL": "C"})
    except (OSError, subprocess.TimeoutExpired):
        raise Refused("HOST_COMMAND_FAILED") from None
    require(len(result.stdout) <= MAX_OUTPUT, "HOST_RESPONSE_TOO_LARGE")
    require(allow_failure or result.returncode == 0, "HOST_COMMAND_FAILED")
    try:
        return result.returncode, result.stdout.decode("utf-8")
    except UnicodeError:
        raise Refused("HOST_RESPONSE_INVALID") from None


def command(args, **kwargs):
    return run(args, **kwargs)[1]


def secure_parents(path):
    path = Path(path)
    require(path.is_absolute() and ".." not in path.parts, "ABSOLUTE_CUSTODY_PATH_REQUIRED")
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in {0, ROOT_UID}
                and not info.st_mode & 0o022, "UNSAFE_PARENT_CUSTODY")


def private_file(path, limit=65536):
    path = Path(path)
    secure_parents(path)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == ROOT_UID
            and not info.st_mode & 0o077 and info.st_size <= limit,
            "PRIVATE_ROOT_OWNED_FILE_REQUIRED")
    return path.read_bytes()


def validate_plan(plan):
    require(isinstance(plan, dict) and set(plan) == PLAN_KEYS, "PLAN_SCHEMA_INVALID")
    require(isinstance(plan["instance_id"], str)
            and re.fullmatch(r"ocid1\.instance\.oc1\.[a-z0-9-]+\.[a-z0-9]{20,128}", plan["instance_id"]),
            "EXPECTED_OCI_INSTANCE_REQUIRED")
    require(isinstance(plan["machine_id_sha256"], str)
            and re.fullmatch(r"[0-9a-f]{64}", plan["machine_id_sha256"]), "EXPECTED_MACHINE_ID_REQUIRED")
    try:
        address = ipaddress.ip_address(plan["private_ip"])
    except (ValueError, TypeError):
        raise Refused("PRIVATE_NODE_IP_REQUIRED") from None
    require(address.version == 4 and any(address in item for item in preflight.PRIVATE_NETWORKS),
            "PRIVATE_NODE_IP_REQUIRED")
    pods, services = preflight.candidate_networks(plan["pod_cidr"], plan["service_cidr"])
    require(address not in pods and address not in services, "NODE_CLUSTER_ADDRESS_OVERLAP")
    reserved = plan["reserved_cidrs"]
    require(isinstance(reserved, list) and 1 <= len(reserved) <= 128
            and all(isinstance(value, str) for value in reserved)
            and len(set(reserved)) == len(reserved), "REVIEWED_NETWORK_RESERVATIONS_REQUIRED")
    networks = [preflight.network(value) for value in reserved]
    require(any(address in network for network in networks), "NODE_SUBNET_RESERVATION_REQUIRED")
    require(not any(candidate.overlaps(network) for candidate in (pods, services) for network in networks),
            "RESERVED_NETWORK_OVERLAP")
    upstream = plan["dns_upstream_ipv4"]
    require(isinstance(upstream, list) and 1 <= len(upstream) <= 3
            and len(set(upstream)) == len(upstream), "OBSERVED_UPSTREAM_DNS_REQUIRED")
    for value in upstream:
        try:
            resolver = ipaddress.IPv4Address(value)
        except (ValueError, TypeError):
            raise Refused("OBSERVED_UPSTREAM_DNS_REQUIRED") from None
        require(not resolver.is_loopback and not resolver.is_unspecified and not resolver.is_multicast
                and resolver not in pods and resolver not in services, "OBSERVED_UPSTREAM_DNS_REQUIRED")
    for key in ("workload_memory_mib", "workload_disk_gib"):
        require(type(plan[key]) is int and 0 <= plan[key] <= 1048576, "WORKLOAD_BUDGET_INVALID")
    return copy.deepcopy(plan)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, newurl):
        raise Refused("IMDS_REDIRECT_REFUSED")


def instance_identity():
    """Two selected noncredential metadata fields only; never the full IMDS tree."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    values = {}
    for key in ("id", "displayName"):
        request = urllib.request.Request("http://169.254.169.254/opc/v2/instance/" + key,
                                         headers={"Authorization": "Bearer Oracle"})
        try:
            with opener.open(request, timeout=5) as response:
                require(response.status == 200, "IMDS_IDENTITY_UNAVAILABLE")
                data = response.read(1025)
            require(len(data) <= 1024, "IMDS_IDENTITY_INVALID")
            values[key] = data.decode("utf-8").strip()
        except (OSError, UnicodeError):
            raise Refused("IMDS_IDENTITY_UNAVAILABLE") from None
    return values


def match_identity(plan, identity, machine_hash):
    require(identity.get("id") == plan["instance_id"], "WRONG_OCI_INSTANCE")
    # A matching user input alone cannot authorize the similarly named source VM.
    label = re.sub(r"[^a-z0-9]", "", identity.get("displayName", "").lower())
    require(label == "onesaugbackend", "ONESA_DESTINATION_IDENTITY_REQUIRED")
    require(machine_hash == plan["machine_id_sha256"], "WRONG_MACHINE_IDENTITY")


def current_identity(plan):
    require(os.geteuid() == 0, "ROOT_HOST_EXECUTION_REQUIRED")
    machine = Path("/etc/machine-id").read_text().strip()
    require(re.fullmatch(r"[0-9a-f]{32}", machine), "HOST_IDENTITY_INVALID")
    match_identity(plan, instance_identity(), digest(machine.encode()))


def releases():
    data = json.loads((Path(__file__).parent / "k3s_release_lock.json").read_text())
    require(data["schema_version"] == 1 and data["k3s"]["prerelease"] is False,
            "RELEASE_LOCK_INVALID")
    return data


def lifecycle_source():
    installed = Path(__file__).parent / "runtime_lifecycle.py"
    return installed if installed.exists() else Path(__file__).resolve().parents[2] / "scripts/release/runtime_lifecycle.py"


def lifecycle_module(lock):
    source = lifecycle_source()
    raw = source.read_bytes()
    require(digest(raw) == lock["shared_lifecycle_sha256"], "SHARED_LIFECYCLE_SOURCE_DRIFT")
    # Execute the exact already-hashed source bytes; importing the path again
    # would introduce a replacement window. This is the existing reviewed API.
    module = types.ModuleType("onesa_shared_runtime_lifecycle")
    module.__file__ = str(source)
    exec(compile(raw, str(source), "exec"), module.__dict__)
    return module


def require_contended_lock(fd, code):
    """Probe an independently opened descriptor without retaining a lease."""
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    fcntl.flock(fd, fcntl.LOCK_UN)
    raise Refused(code)


def check_service_lease(plan, receipt, lock):
    """Initial service children require the matching live installer, not a stale hold."""
    module = lifecycle_module(lock)
    try:
        module.private_path(module.STATE, directory=True)
        # Independent read-only descriptors probe the existing locks only. A
        # successful probe is immediately released and refuses a stale owner.
        fd = os.open(module.LOCK, os.O_RDONLY | os.O_NOFOLLOW)
        observer = module.LifecycleGuard(fd)
        try:
            hold = observer.read_hold()
            if hold is not None:
                require(not hold.get("revocations"), "SHARED_HOST_REVOCATION_REQUIRES_REVIEW")
                require(receipt["phase"] != "READY_OWNER_QUALIFICATION_REQUIRED",
                        "SHARED_HOST_MAINTENANCE_RECONCILIATION_REQUIRED")
                require(all(hold.get(key) == expected for key, expected in {
                    "kind": LEASE_KIND, "scope": LEASE_SCOPE,
                    "reference": digest(encoded(plan)), "token": receipt.get("maintenance_token"),
                }.items()), "UNRELATED_SHARED_HOST_MAINTENANCE")
                require_contended_lock(fd, "INSTALLATION_GLOBAL_LOCK_INACTIVE")
                # An unrelated owner/recovery process can hold the global lock
                # while a stale maintenance record remains. Only the live first
                # installer also owns this existing component lock.
                component_fd = os.open(LOCK, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    module._same_file(component_fd, LOCK)
                    require_contended_lock(component_fd, "INSTALLATION_COMPONENT_LOCK_INACTIVE")
                    module._same_file(component_fd, LOCK)
                finally:
                    os.close(component_fd)
                require(observer.read_hold() == hold, "INSTALLATION_MAINTENANCE_HOLD_CHANGED")
            else:
                require(receipt["phase"] == "READY_OWNER_QUALIFICATION_REQUIRED", "INSTALLATION_MAINTENANCE_HOLD_MISSING")
        finally:
            observer._open = False
            os.close(fd)
    except module.LifecycleError as error:
        raise Refused(str(error)) from None


def clean_server_exec():
    """Keep systemd notification only; never inherit manager K3S/proxy variables."""
    notify = os.environ.get("NOTIFY_SOCKET", "")
    require(0 < len(notify) <= 256 and notify[0] in {"/", "@"}
            and not any(character in notify for character in "\x00\r\n"), "SYSTEMD_NOTIFICATION_SOCKET_REQUIRED")
    environment = {"PATH": preflight.SAFE_PATH, "LANG": "C", "LC_ALL": "C", "NOTIFY_SOCKET": notify}
    os.execve(BINARY, [str(BINARY), "server", "--config", str(CONFIG)], environment)


def artifacts(directory, architecture, lock):
    platform = {"aarch64": "arm64", "x86_64": "amd64"}.get(architecture)
    require(platform is not None, "HOST_ARCHITECTURE_UNSUPPORTED")
    result = {}
    for key, item in lock["k3s"]["platforms"][platform].items():
        require(key in {"binary", "airgap"}, "RELEASE_LOCK_INVALID")
        path = Path(directory) / item["name"]
        verified_artifact_bytes(path, item)
        result[key] = path
    require(set(result) == {"binary", "airgap"}, "RELEASE_LOCK_INVALID")
    return result


def verified_artifact_bytes(path, item):
    """Verify and copy the exact descriptor bytes, never a separately read path."""
    path = Path(path)
    secure_parents(path)
    require(type(item["size"]) is int and 0 < item["size"] <= 1024 ** 3, "ARTIFACT_SIZE_INVALID")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        raise Refused("ARTIFACT_FILE_INVALID") from None
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == ROOT_UID
                and not before.st_mode & 0o022 and before.st_nlink == 1
                and before.st_size == item["size"], "ARTIFACT_FILE_INVALID")
        with os.fdopen(os.dup(fd), "rb") as source:
            data = source.read(item["size"] + 1)
        after, current = os.fstat(fd), path.lstat()
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                and (after.st_dev, after.st_ino) == (current.st_dev, current.st_ino)
                and after.st_nlink == 1, "ARTIFACT_REPLACED_DURING_READ")
        require(len(data) == item["size"] and digest(data) == item["sha256"], "ARTIFACT_HASH_MISMATCH")
        secure_parents(path)
        return data
    finally:
        os.close(fd)


def parse_rules(text):
    tables, table = {}, None
    for line in text.splitlines():
        if not line or line.startswith("#") or line == "COMMIT":
            continue
        if line.startswith("*"):
            table = line[1:]
            require(table not in tables, "FIREWALL_SNAPSHOT_INVALID")
            tables[table] = {"chains": {}, "rules": []}
        elif line.startswith(":") and table:
            parts = line[1:].split()
            require(len(parts) == 3, "FIREWALL_SNAPSHOT_INVALID")
            tables[table]["chains"][parts[0]] = parts[1]
        elif line.startswith("-A ") and table:
            tables[table]["rules"].append(shlex.split(line))
        else:
            raise Refused("FIREWALL_SNAPSHOT_INVALID")
    require("filter" in tables, "FIREWALL_SNAPSHOT_INVALID")
    return tables


def snapshot_firewall():
    return {family: parse_rules(command([family + "-save"])) for family in ("iptables", "ip6tables")}


def snapshot_policy_routes():
    return {family: json.loads(command(["ip", "-json", family, "rule", "show"])) for family in ("-4", "-6")}


def native_tables():
    rows = json.loads(command(["nft", "--json", "list", "tables"]))["nftables"]
    require(isinstance(rows, list) and len(rows) <= 256, "NATIVE_FIREWALL_INVENTORY_INVALID")
    names = []
    for row in rows:
        table = row.get("table")
        if table and table.get("family") == "inet":
            name = table.get("name", "")
            require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", name), "NATIVE_FIREWALL_TABLE_INVALID")
            names.append(name)
    require(len(names) == len(set(names)), "NATIVE_FIREWALL_INVENTORY_INVALID")
    return sorted(names)


def native_digest(name):
    require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", name), "NATIVE_FIREWALL_TABLE_INVALID")
    # No counters or handles are introduced in the new guard. Existing native
    # tables are retained verbatim; a changed rule requires a fresh review.
    return digest(command(["nft", "--numeric", "list", "table", "inet", name]).encode())


def snapshot_native_guards():
    return {name: native_digest(name) for name in native_tables() if name != NATIVE_TABLE}


def protected_networks(plan, docker_subnets):
    networks = sorted(set(plan["reserved_cidrs"] + docker_subnets + ["169.254.0.0/16"]))
    for value in networks:
        preflight.network(value)
    return networks


def require_netpol_mark_reservation(firewall, native_rules):
    """The bundled policy controller owns bit 0x20000; never steal a host mark.

    This first-install proof deliberately refuses an existing netfilter mark
    writer or consumer. Policy-routing rules are observed separately: routing
    has already occurred at the INPUT/FORWARD hooks where we clear this bit.
    No OUTPUT mark is changed, so policy-route selection is not rewritten.
    """
    for tables in firewall.values():
        for table in tables.values():
            for rule in table["rules"]:
                tokens = list(rule)
                if "--comment" in tokens:
                    offset = tokens.index("--comment")
                    del tokens[offset:offset + 2]
                require(not any("mark" in token.lower() for token in tokens),
                        "EXISTING_NETFILTER_MARK_REQUIRES_REVIEW")
        output = tables["filter"]
        require(output["chains"].get("OUTPUT") == "ACCEPT"
                and not any(rule[1] == "OUTPUT" for rule in output["rules"]),
                "EXISTING_OUTPUT_POLICY_REQUIRES_REVIEW")
    # Native table text is retained privately, never emitted as diagnostic text.
    require(not re.search(r"\b(?:meta|ct)\s+mark\b", native_rules),
            "EXISTING_NETFILTER_MARK_REQUIRES_REVIEW")


def require_nftables_support():
    version = re.search(r"nftables v(\d+)\.(\d+)\.(\d+)", command(["nft", "--version"]))
    require(version is not None and tuple(map(int, version.groups())) >= (1, 0, 1),
            "NFTABLES_USERSPACE_VERSION_UNSUPPORTED")
    kernel = re.match(r"(\d+)\.(\d+)", os.uname().release)
    require(kernel is not None and tuple(map(int, kernel.groups())) >= (5, 13),
            "NFTABLES_KERNEL_VERSION_UNSUPPORTED")


def require_observed_dns(plan):
    observed = []
    # systemd's stub is not reachable from a pod; retain its actual upstream.
    source = Path("/run/systemd/resolve/resolv.conf")
    if not source.is_file():
        source = Path("/etc/resolv.conf")
    for line in source.read_text().splitlines():
        fields = line.split()
        if fields and fields[0] == "nameserver":
            require(len(fields) == 2, "UPSTREAM_DNS_OBSERVATION_INVALID")
            observed.append(fields[1])
    require(observed == plan["dns_upstream_ipv4"], "UPSTREAM_DNS_CHANGED_OR_UNAPPROVED")


def native_guard_source(plan, docker_subnets):
    pods, services, private_ip = plan["pod_cidr"], plan["service_cidr"], plan["private_ip"]
    protected = ", ".join(protected_networks(plan, docker_subnets))
    dns = ", ".join(plan["dns_upstream_ipv4"])
    # Separate base-chain drops remain final regardless of the relative order
    # of kube-router, Flannel, Docker and the retained owner reconciler. The
    # standard nftables proxier never inserts a global iptables ESTABLISHED
    # accept. The reserved network-policy accept bit cannot authorize unrelated
    # packets; every other mark bit remains intact and OUTPUT is untouched.
    return (f"create table inet {NATIVE_TABLE}\n"
            f"add chain inet {NATIVE_TABLE} input {{ type filter hook input priority -75; policy accept; }}\n"
            f"add rule inet {NATIVE_TABLE} input iifname lo return\n"
            f"add rule inet {NATIVE_TABLE} input iifname != cni0 ip saddr {pods} drop\n"
            f"add rule inet {NATIVE_TABLE} input iifname != cni0 meta mark set meta mark & 0xfffdffff\n"
            f"add rule inet {NATIVE_TABLE} input iifname cni0 ip saddr {pods} ip daddr {private_ip} tcp dport {{ 6443, 10250 }} return\n"
            f"add rule inet {NATIVE_TABLE} input iifname cni0 drop\n"
            f"add rule inet {NATIVE_TABLE} input tcp dport {{ 6443, 10250 }} drop\n"
            f"add chain inet {NATIVE_TABLE} forward {{ type filter hook forward priority -75; policy accept; }}\n"
            f"add rule inet {NATIVE_TABLE} forward iifname cni0 meta nfproto ipv6 drop\n"
            f"add rule inet {NATIVE_TABLE} forward oifname cni0 meta nfproto ipv6 drop\n"
            f"add rule inet {NATIVE_TABLE} forward iifname != cni0 ip saddr {pods} drop\n"
            f"add rule inet {NATIVE_TABLE} forward iifname cni0 ip saddr != {pods} drop\n"
            f"add rule inet {NATIVE_TABLE} forward iifname cni0 ip daddr {{ {dns} }} udp dport 53 return\n"
            f"add rule inet {NATIVE_TABLE} forward iifname cni0 ip daddr {{ {dns} }} tcp dport 53 return\n"
            f"add rule inet {NATIVE_TABLE} forward iifname cni0 ip daddr {{ {protected} }} drop\n"
            f"add rule inet {NATIVE_TABLE} forward iifname cni0 return\n"
            f"add rule inet {NATIVE_TABLE} forward ip daddr {pods} ct state established,related ct original ip saddr {pods} ct direction reply return\n"
            f"add rule inet {NATIVE_TABLE} forward ip daddr {{ {pods}, {services} }} drop\n"
            f"add rule inet {NATIVE_TABLE} forward oifname cni0 drop\n"
            f"add rule inet {NATIVE_TABLE} forward meta mark set meta mark & 0xfffdffff\n").encode()


def ensure_native_guard(plan, receipt, *, first_install=False):
    require(snapshot_native_guards() == receipt["native_before"], "EXISTING_NATIVE_FIREWALL_CHANGED")
    path = STATE / "private-firewall.nft"
    require(private_file(path) == native_guard_source(plan, receipt["docker_subnets"]), "PRIVATE_NATIVE_SOURCE_DRIFT")
    present = NATIVE_TABLE in native_tables()
    if first_install:
        require(not present and "native_guard_sha256" not in receipt, "EXISTING_PRIVATE_NATIVE_GUARD_REFUSED")
    elif present:
        require(native_digest(NATIVE_TABLE) == receipt.get("native_guard_sha256"), "PRIVATE_NATIVE_FIREWALL_DRIFT")
        return
    else:
        require(re.fullmatch(r"[0-9a-f]{64}", receipt.get("native_guard_sha256", "")), "PRIVATE_NATIVE_CUSTODY_REQUIRED")
    # nft submits the new table as one transaction; never flush or replace an
    # existing table. A missing retained table may be restored after reboot.
    command(["nft", "--file", str(path)])
    observed = native_digest(NATIVE_TABLE)
    if first_install:
        receipt["native_guard_sha256"] = observed
        save_receipt(receipt)
    else:
        require(observed == receipt["native_guard_sha256"], "PRIVATE_NATIVE_FIREWALL_DRIFT")
    require(snapshot_native_guards() == receipt["native_before"], "EXISTING_NATIVE_FIREWALL_CHANGED")


def require_existing_firewall(snapshot):
    for family, tables in snapshot.items():
        current = tables["filter"]
        rules = current["rules"]
        require("ONESA_WORKER_INPUT" in current["chains"]
                and ["-A", "INPUT", "-j", "ONESA_WORKER_INPUT"] in rules
                and ["-A", "ONESA_WORKER_INPUT", "-j", "DROP"] in rules
                and ["-A", "ONESA_WORKER_INPUT", "-i", "tailscale0", "-j", "DROP"] in rules
                and ["-A", "FORWARD", "-i", "tailscale0", "-j", "DROP"] in rules,
                "REVIEWED_ONESA_FIREWALL_REQUIRED")
        if family == "iptables":
            require("DOCKER-USER" in current["chains"]
                    and ["-A", "FORWARD", "-j", "DOCKER-USER"] in rules,
                    "REVIEWED_DOCKER_FORWARD_GUARD_REQUIRED")


def preserved_firewall(before, after):
    """Keep every original policy/rule in order; new rules must be cluster owned."""
    prefixes = ("KUBE-", "CNI-", "FLANNEL-")
    own = {INPUT_CHAIN, FORWARD_CHAIN}
    for family, tables in before.items():
        require(set(tables).issubset(after[family]), "EXISTING_FIREWALL_CHANGED")
        for table, old in tables.items():
            new = after[family][table]
            require(all(new["chains"].get(key) == policy for key, policy in old["chains"].items()),
                    "EXISTING_FIREWALL_CHANGED")
            new_chains = set(new["chains"]) - set(old["chains"])
            require(all(name in own or name.startswith(prefixes) for name in new_chains),
                    "UNEXPECTED_FIREWALL_CHAIN")
            retained = []
            for rule in new["rules"]:
                chain = rule[1]
                target = rule[rule.index("-j") + 1] if "-j" in rule else None
                if chain in new_chains or target in new_chains:
                    continue
                if table == "filter" and netpol_accept(rule):
                    continue
                retained.append(rule)
            require(retained == old["rules"], "EXISTING_FIREWALL_CHANGED")
    # Any entirely new table is accepted only with cluster-owned chains/rules.
    for family, tables in after.items():
        for name in set(tables) - set(before[family]):
            require(not tables[name]["rules"], "UNEXPECTED_FIREWALL_TABLE")


def firewall_rules(plan, docker_subnets):
    private_ip, pods = plan["private_ip"], plan["pod_cidr"]
    v4_input = [["-i", "lo", "-j", "RETURN"]]
    for port in (6443, 10250):
        # iptables-save serializes address matches before interface matches.
        v4_input += [["-s", pods, "-d", private_ip + "/32", "-i", "cni0", "-p", "tcp", "-m", "tcp", "--dport", str(port), "-j", "ACCEPT"],
                     ["-p", "tcp", "-m", "tcp", "--dport", str(port), "-j", "DROP"]]
    v4_input.append(["-j", "RETURN"])
    v6_input = [["-i", "lo", "-j", "RETURN"],
                ["-p", "tcp", "-m", "multiport", "--dports", "6443,10250", "-j", "DROP"], ["-j", "RETURN"]]
    # Refuse new pod-to-Docker traffic before an existing Docker user ACCEPT can
    # terminate traversal. Unrelated traffic must return to the retained parent
    # policy, including scoped owner tunnels before its final Tailscale drop.
    v4_forward = []
    for upstream in plan["dns_upstream_ipv4"]:
        for protocol in ("tcp", "udp"):
            v4_forward.append(["-d", upstream + "/32", "-i", "cni0", "-p", protocol,
                               "-m", protocol, "--dport", "53", "-j", "RETURN"])
    for subnet in protected_networks(plan, docker_subnets):
        v4_forward.append(["-d", subnet, "-i", "cni0", "-j", "DROP"])
    # Preserve replies to pod-initiated egress after reverse NAT, without allowing
    # a new connection into the cluster. These still traverse the Docker guard.
    reply = ["-d", pods, "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED",
             "--ctorigsrc", pods, "--ctdir", "REPLY"]
    v4_forward.extend([[*reply, "-j", "DOCKER-USER"], [*reply, "-j", "RETURN"],
                       ["-i", "cni0", "-j", "DOCKER-USER"], ["-i", "cni0", "-j", "RETURN"]])
    # This single-node management cluster has no external ingress. Deny traffic
    # entering its networks from any other interface before KUBE/FLANNEL accepts.
    v4_forward.extend([["-d", cidr, "-j", "DROP"] for cidr in (pods, plan["service_cidr"])])
    v4_forward.extend([["-o", "cni0", "-j", "DROP"], ["-j", "RETURN"]])
    return {"iptables": {INPUT_CHAIN: v4_input, FORWARD_CHAIN: v4_forward},
            "ip6tables": {INPUT_CHAIN: v6_input,
                           FORWARD_CHAIN: [["-j", "RETURN"]]}}


def apply_private_firewall(plan, docker_subnets):
    desired = firewall_rules(plan, docker_subnets)
    existing = snapshot_firewall()
    for family, chains in desired.items():
        observed = existing[family]["filter"]
        for chain, rules in chains.items():
            if chain in observed["chains"]:
                actual = [row[2:] for row in observed["rules"] if row[1] == chain]
                require(actual == rules, "OWNED_FIREWALL_DRIFT")
            else:
                command([family, "-w", "5", "-N", chain])
                for rule in rules:
                    command([family, "-w", "5", "-A", chain, *rule])
            parent = "INPUT" if chain == INPUT_CHAIN else "FORWARD"
            # Move only our own jump. Never flush, rewrite or restore other chains.
            for _ in range(32):
                status, _output = run([family, "-w", "5", "-C", parent, "-j", chain], allow_failure=True)
                require(status in (0, 1), "FIREWALL_JUMP_OBSERVATION_FAILED")
                if status == 1:
                    break
                command([family, "-w", "5", "-D", parent, "-j", chain])
            else:
                raise Refused("DUPLICATE_PRIVATE_FIREWALL_JUMPS")
            command([family, "-w", "5", "-I", parent, "1", "-j", chain])


def verify_firewall(plan, docker_subnets, baseline):
    current = snapshot_firewall()
    preserved_firewall(baseline, current)
    for family, chains in firewall_rules(plan, docker_subnets).items():
        rows = current[family]["filter"]["rules"]
        for chain, desired in chains.items():
            require([row[2:] for row in rows if row[1] == chain] == desired, "PRIVATE_FIREWALL_DRIFT")
            parent = "INPUT" if chain == INPUT_CHAIN else "FORWARD"
            parent_rows = [row for row in rows if row[1] == parent]
            jump = ["-A", parent, "-j", chain]
            require(parent_rows.count(jump) == 1, "PRIVATE_FIREWALL_ORDER_CHANGED")
            preceding = parent_rows[:parent_rows.index(jump)]
            # The bundled policy controller and the retained owner reconciler
            # legitimately prepend their own jumps/permits. Independent native
            # base-chain restrictions remain authoritative through either order.
            old_rows = baseline[family]["filter"]["rules"]
            allowed_controller = "KUBE-ROUTER-" + parent
            require(all((chain == FORWARD_CHAIN and family == "iptables"
                         and row in old_rows and outside_cluster_permit(row, plan))
                        or controller_jump(row, allowed_controller) or netpol_accept(row) for row in preceding),
                    "PRIVATE_FIREWALL_ORDER_CHANGED")
    verify_scoped_forward_controllers(current, plan)


def without_comment(rule):
    result = list(rule)
    if "--comment" in result:
        index = result.index("--comment")
        require(index >= 2 and result[index - 2:index] == ["-m", "comment"]
                and index + 1 < len(result), "CLUSTER_RULE_SHAPE_CHANGED")
        del result[index - 2:index + 2]
    return result


def controller_jump(rule, target):
    return without_comment(rule)[2:] == ["-j", target]


def netpol_accept(rule):
    if rule[1] not in {"INPUT", "FORWARD", "OUTPUT"} or "--comment" not in rule:
        return False
    comment = rule[rule.index("--comment") + 1]
    return (comment == "KUBE-ROUTER rule to explicitly ACCEPT traffic that comply to network policies"
            and without_comment(rule)[2:] == ["-m", "mark", "--mark", "0x20000/0x20000", "-j", "ACCEPT"])


def verify_scoped_forward_controllers(snapshot, plan):
    """Qualify the locked controllers' outer selectors, not arbitrary KUBE names."""
    pods = preflight.network(plan["pod_cidr"])
    for family, tables in snapshot.items():
        current = tables["filter"]
        require("KUBE-FORWARD" not in current["chains"], "IPTABLES_KUBE_PROXY_REFUSED")
        for original in current["rules"]:
            rule = without_comment(original)
            if rule[1] == "FORWARD" and "-j" in rule:
                target = rule[rule.index("-j") + 1]
                if target.startswith(("KUBE-", "FLANNEL-")):
                    require(target in {"KUBE-ROUTER-FORWARD", "FLANNEL-FWD"}
                            and rule[2:] == ["-j", target], "CLUSTER_FORWARD_DISPATCH_CHANGED")
            if rule[1] == "FLANNEL-FWD":
                require(family == "iptables" and rule[2:] in
                        (["-s", str(pods), "-j", "ACCEPT"], ["-d", str(pods), "-j", "ACCEPT"]),
                        "FLANNEL_FORWARD_SCOPE_CHANGED")
            if rule[1] != "KUBE-ROUTER-FORWARD":
                continue
            body = rule[2:]
            for flag in ("-s", "-d"):
                if flag in body and body.count(flag) == 1:
                    address = preflight.network(body[body.index(flag) + 1])
                    if address.prefixlen == 32 and address.subnet_of(pods):
                        break
            else:
                raise Refused("NETWORK_POLICY_FORWARD_SCOPE_CHANGED")
            require("-j" in body and body[-2] == "-j" and body[-1].startswith("KUBE-POD-FW-")
                    and "!" not in body and "-g" not in body, "NETWORK_POLICY_FORWARD_SCOPE_CHANGED")


def verify_nftables_proxy():
    rows = json.loads(command(["nft", "--json", "list", "table", "ip", "kube-proxy"]))["nftables"]
    forward = [item["chain"] for item in rows if item.get("chain", {}).get("name") == "filter-forward"]
    require(len(forward) == 1 and forward[0].get("hook") == "forward"
            and forward[0].get("type") == "filter" and forward[0].get("prio") == 0,
            "NFTABLES_PROXY_RUNTIME_UNVERIFIED")


def outside_cluster_permit(rule, plan):
    if "!" in rule or "-g" in rule or rule[-2:] != ["-j", "ACCEPT"]:
        return False
    try:
        for flag in ("-i", "-o"):
            if rule.count(flag) != 1:
                return False
            interface = rule[rule.index(flag) + 1]
            if interface == "cni0" or not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", interface):
                return False
        for flag in ("-s", "-d"):
            if rule.count(flag) != 1:
                return False
            address = preflight.network(rule[rule.index(flag) + 1])
            if any(address.overlaps(preflight.network(value)) for value in (plan["pod_cidr"], plan["service_cidr"])):
                return False
    except (IndexError, Refused):
        return False
    return True


def local_address(plan):
    rows = json.loads(command(["ip", "-json", "-4", "address", "show"]))
    matches = [row["ifname"] for row in rows if any(
        item.get("local") == plan["private_ip"] and item.get("scope") == "global"
        for item in row.get("addr_info", []))]
    require(len(matches) == 1 and re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", matches[0])
            and matches[0] not in {"lo", "cni0", "docker0", "tailscale0"}, "PRIVATE_IP_NOT_ON_HOST")
    return matches[0]


def docker_networks():
    base = ["docker", "--host", "unix:///var/run/docker.sock"]
    identifiers = command([*base, "network", "ls", "--quiet", "--no-trunc"]).splitlines()
    require(identifiers and len(identifiers) <= 256
            and all(re.fullmatch(r"[a-f0-9]{64}", item) for item in identifiers), "DOCKER_NETWORK_INVENTORY_INVALID")
    return preflight.docker_networks(command([*base, "network", "inspect", "--format", "{{json .IPAM.Config}}", *identifiers]))


def unoccupied_boundary(firewall):
    paths = (STATE, CONFIG_DIR, DATA, LIB, BINARY, Path("/run/k3s"), Path("/var/lib/kubelet"),
             Path("/etc/cni/net.d"), Path("/etc/kubernetes"), UNIT_DIR / UNIT, UNIT_DIR / FIREWALL_UNIT,
             UNIT_DIR / "k3s.service", UNIT_DIR / "k3s-agent.service")
    require(not any(path.exists() or path.is_symlink() for path in paths), "EXISTING_CLUSTER_OR_INSTALLATION_REFUSED")
    for unit in (UNIT, FIREWALL_UNIT):
        state = unit_metadata(unit)
        require(state == {"LoadState": "not-found", "FragmentPath": "", "DropInPaths": "", "Transient": "no"},
                "EXISTING_EFFECTIVE_SYSTEMD_UNIT_REFUSED")
    units = command(["systemctl", "list-unit-files", "--no-legend", "--no-pager"])
    require(not any(re.match(r"(?:k3s(?:-agent)?|rke2(?:-server|-agent)?|kubelet|onesa-k3s)\.service\s", line)
                    for line in units.splitlines()), "EXISTING_CLUSTER_SERVICE_REFUSED")
    interfaces = json.loads(command(["ip", "-json", "link", "show"]))
    require(not any(row.get("ifname", "").startswith(("cni", "flannel", "kube-ipvs")) for row in interfaces),
            "EXISTING_CLUSTER_INTERFACE_REFUSED")
    for tables in firewall.values():
        require(not any(name.startswith(("KUBE-", "CNI-", "FLANNEL-", "ONESA_K3S"))
                        for table in tables.values() for name in table["chains"]), "EXISTING_CLUSTER_RULES_REFUSED")


def require_bridge_netfilter():
    """Read existing prerequisites only; loading the module affects live bridges."""
    observed = {}
    for name in ("bridge-nf-call-iptables", "bridge-nf-call-ip6tables"):
        try:
            value = (Path("/proc/sys/net/bridge") / name).read_text().strip()
        except FileNotFoundError:
            raise Refused("BRIDGE_NETFILTER_SYSCTL_MISSING:" + name) from None
        except OSError:
            raise Refused("BRIDGE_NETFILTER_SYSCTL_UNREADABLE:" + name) from None
        require(value in {"0", "1"}, "BRIDGE_NETFILTER_SYSCTL_INVALID:" + name)
        require(value == "1", "BRIDGE_NETFILTER_SYSCTL_DISABLED:" + name)
        observed[name] = 1
    return observed


def collect_first_install(plan, artifact_dir, lock):
    current_identity(plan)
    observation = preflight.collect()
    result = preflight.assess(observation, pod_cidr=plan["pod_cidr"], service_cidr=plan["service_cidr"],
                              workload_memory_mib=plan["workload_memory_mib"], workload_disk_gib=plan["workload_disk_gib"])
    # The old helper correctly blocks here: only this installer supplies and
    # independently verifies the explicit integration, rather than weakening it.
    blockers = set(result["blockers"]) - {"EXISTING_ONESA_FIREWALL_INTEGRATION_REQUIRED"}
    require(not blockers, "HOST_PREFLIGHT_BLOCKED")
    require(observation["memory_total_mib"] >= 5632, "EXISTING_SIX_GIB_HOST_MEMORY_REQUIRED")
    require_bridge_netfilter()
    firewall = snapshot_firewall()
    require_existing_firewall(firewall)
    require_nftables_support()
    require_observed_dns(plan)
    require_netpol_mark_reservation(firewall, command(["nft", "list", "ruleset"]))
    unoccupied_boundary(firewall)
    require(NATIVE_TABLE not in native_tables(), "EXISTING_PRIVATE_NATIVE_GUARD_REFUSED")
    native = snapshot_native_guards()
    sources = artifacts(artifact_dir, observation["architecture"], lock)
    interface = local_address(plan)
    node = portainer.name(command(["hostname"]).strip().lower())
    networks = docker_networks()
    return {"observation": observation, "firewall": firewall, "sources": sources,
            "interface": interface, "node": node, "docker_subnets": networks, "native": native,
            "policy_routes": snapshot_policy_routes()}


def configuration(plan, node, interface):
    services = preflight.network(plan["service_cidr"])
    return {"bind-address": plan["private_ip"], "advertise-address": plan["private_ip"],
            "node-ip": plan["private_ip"], "node-name": node, "tls-san": [plan["private_ip"]],
            "cluster-cidr": plan["pod_cidr"], "service-cidr": plan["service_cidr"],
            "cluster-dns": str(services.network_address + 10), "flannel-iface": interface,
            "flannel-backend": "host-gw", "write-kubeconfig-mode": "0600", "secrets-encryption": True,
            "resolv-conf": str(STATE / "resolv.conf"),
            "disable": ["traefik", "servicelb", "local-storage"], "disable-helm-controller": True,
            "kube-proxy-arg": ["proxy-mode=nftables", "nodeport-addresses=127.0.0.0/8", "healthz-bind-address=127.0.0.1:10256", "metrics-bind-address=127.0.0.1:10249"],
            "kubelet-arg": ["address=" + plan["private_ip"], "read-only-port=0"]}


def manifests(lock, node):
    base = portainer.manifest("portainer/portainer-ce@" + lock["portainer"]["index_digest"], STORAGE_CLASS, node, "4Gi")
    portainer.by_kind(base["items"], "PersistentVolumeClaim")["spec"]["volumeName"] = VOLUME
    storage = [{"apiVersion": "storage.k8s.io/v1", "kind": "StorageClass", "metadata": {"name": STORAGE_CLASS},
                "provisioner": "kubernetes.io/no-provisioner", "reclaimPolicy": "Retain", "volumeBindingMode": "WaitForFirstConsumer"},
               {"apiVersion": "v1", "kind": "PersistentVolume", "metadata": {"name": VOLUME},
                "spec": {"capacity": {"storage": "4Gi"}, "volumeMode": "Filesystem", "accessModes": ["ReadWriteOnce"],
                         "persistentVolumeReclaimPolicy": "Retain", "storageClassName": STORAGE_CLASS,
                         "local": {"path": str(STATE / "portainer")}, "nodeAffinity": {"required": {"nodeSelectorTerms": [
                             {"matchExpressions": [{"key": "kubernetes.io/hostname", "operator": "In", "values": [node]}]}]}}}}]
    return base, {"apiVersion": "v1", "kind": "List", "items": storage + base["items"]}


def network_policies(plan):
    """Initial management namespaces; only CoreDNS may use the host upstream.

    Namespace and pod selectors form one identity. A same-labelled application
    in another namespace cannot inherit the CoreDNS exception. Future workload
    namespaces require their own reviewed egress policy before admission.
    """
    def policy(namespace, name, selector, egress):
        return {"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
                "metadata": {"namespace": namespace, "name": name},
                "spec": {"podSelector": selector, "policyTypes": ["Egress"], "egress": egress}}

    api_address = str(preflight.network(plan["service_cidr"]).network_address + 1)
    api = {"to": [{"ipBlock": {"cidr": plan["private_ip"] + "/32"}},
                  {"ipBlock": {"cidr": api_address + "/32"}}],
           "ports": [{"protocol": "TCP", "port": port} for port in (443, 6443)]}
    dns_ports = [{"protocol": protocol, "port": 53} for protocol in ("UDP", "TCP")]
    upstream = {"to": [{"ipBlock": {"cidr": value + "/32"}} for value in plan["dns_upstream_ipv4"]],
                "ports": dns_ports}
    cluster_dns = {"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}},
                           "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}}}], "ports": dns_ports}
    policies = [policy(namespace, "onesa-default-deny-egress", {}, [])
                for namespace in ("default", "kube-system", "kube-public", "kube-node-lease", "portainer")]
    policies += [
        policy("kube-system", "onesa-coredns-egress", {"matchLabels": {"k8s-app": "kube-dns"}}, [api, upstream]),
        policy("kube-system", "onesa-metrics-egress", {"matchLabels": {"k8s-app": "metrics-server"}},
               [api, {"to": [{"ipBlock": {"cidr": plan["private_ip"] + "/32"}}],
                      "ports": [{"protocol": "TCP", "port": 10250}]}]),
        policy("portainer", "onesa-portainer-egress", {"matchLabels": dict(portainer.LABELS)}, [api, cluster_dns]),
    ]
    return {"apiVersion": "v1", "kind": "List", "items": policies}


def verify_network_policies(plan):
    expected = network_policies(plan)
    allowed_namespaces = {item["metadata"]["namespace"] for item in expected["items"]}
    actual_namespaces = {item["metadata"]["name"] for item in get_resource("namespaces")["items"]}
    require(actual_namespaces == allowed_namespaces, "NEW_WORKLOAD_NAMESPACE_REQUIRES_NETWORK_REVIEW")
    for namespace in sorted(allowed_namespaces):
        actual = get_resource("networkpolicies", namespace)["items"]
        desired = [item for item in expected["items"] if item["metadata"]["namespace"] == namespace]
        if namespace == "portainer":
            desired += [item for item in portainer.manifest("portainer/portainer-ce@" + releases()["portainer"]["index_digest"],
                                                          STORAGE_CLASS, "unused", "4Gi")["items"]
                        if item["kind"] == "NetworkPolicy"]
        # Policies combine additively. A competing allow cannot silently widen
        # the upstream DNS exception while the expected deny policy still exists.
        require(len(actual) == len(desired), "UNREVIEWED_NETWORK_POLICY")
        for wanted in desired:
            found = [item for item in actual if item["metadata"]["name"] == wanted["metadata"]["name"]]
            require(len(found) == 1, "NETWORK_POLICY_DRIFT")
            observed = copy.deepcopy(found[0])
            # Kubernetes omits empty ingress/egress arrays when serializing a
            # deny-all policy. Normalize only those intentionally empty fields.
            for direction in ("ingress", "egress"):
                if wanted["spec"].get(direction) == []:
                    observed.setdefault("spec", {}).setdefault(direction, [])
            require(portainer.includes(wanted, observed), "NETWORK_POLICY_DRIFT")
            require(observed.get("spec") == wanted["spec"], "NETWORK_POLICY_RULES_WIDENED")
    dns = get_resource("deployment/coredns", "kube-system")
    template = dns["spec"]["template"]
    require(template["metadata"].get("labels", {}).get("k8s-app") == "kube-dns"
            and template["spec"].get("serviceAccountName") == "coredns"
            and not template["spec"].get("hostNetwork"), "COREDNS_WORKLOAD_IDENTITY_CHANGED")
    require(dns.get("status", {}).get("availableReplicas", 0) >= 1,
            "COREDNS_API_SYNCHRONIZATION_UNVERIFIED")


def verify_api_service(plan):
    service = get_resource("service/kubernetes", "default")
    address = str(preflight.network(plan["service_cidr"]).network_address + 1)
    require(service["spec"].get("type") == "ClusterIP" and service["spec"].get("clusterIP") == address
            and service["spec"].get("ports") == [{"name": "https", "port": 443, "protocol": "TCP", "targetPort": 6443}],
            "KUBERNETES_API_SERVICE_CHANGED")
    slices = get_resource("endpointslices", "default")["items"]
    selected = [item for item in slices if item["metadata"].get("labels", {}).get("kubernetes.io/service-name") == "kubernetes"]
    addresses = [value for item in selected for endpoint in item.get("endpoints", [])
                 if endpoint.get("conditions", {}).get("ready") is True for value in endpoint.get("addresses", [])]
    require(addresses == [plan["private_ip"]]
            and all(item.get("addressType") == "IPv4" and item.get("ports") ==
                    [{"name": "https", "port": 6443, "protocol": "TCP"}] for item in selected),
            "POD_API_ENDPOINT_UNREACHABLE_OR_CHANGED")


def service_files():
    firewall_command = "/usr/bin/python3 " + str(LIB / "k3s_first_install.py") + " firewall --plan " + str(STATE / "plan.json")
    return {FIREWALL_UNIT: "\n".join([
        "[Unit]", "Description=Onesa private Kubernetes firewall", "After=network-online.target docker.service",
        "Before=" + UNIT, "[Service]", "Type=oneshot", "RemainAfterExit=yes", "UMask=0077",
        "ExecStart=" + firewall_command, "[Install]", "WantedBy=multi-user.target", ""]),
        UNIT: "\n".join([
            "[Unit]", "Description=Onesa isolated single-node K3s management cluster",
            "Wants=network-online.target", "After=network-online.target " + FIREWALL_UNIT,
            "Requires=" + FIREWALL_UNIT, "[Service]", "Type=notify", "Delegate=yes", "UMask=0077",
            "Environment=PATH=" + preflight.SAFE_PATH,
            "ExecStart=/usr/bin/python3 " + str(LIB / "k3s_first_install.py") + " serve --plan " + str(STATE / "plan.json"),
            "ExecStartPost=" + firewall_command, "KillMode=process", "Restart=on-failure", "RestartSec=5s",
            "TimeoutStartSec=300s", "TimeoutStopSec=60s", "LimitNOFILE=1048576", "TasksMax=infinity",
            "[Install]", "WantedBy=multi-user.target", ""])}


def unit_metadata(unit):
    require(unit in {UNIT, FIREWALL_UNIT}, "OWNED_UNIT_NAME_REQUIRED")
    output = command(["systemctl", "show", unit, "--no-pager",
                      "--property=LoadState,FragmentPath,DropInPaths,Transient"])
    values = {}
    for line in output.splitlines():
        key, separator, value = line.partition("=")
        require(separator and key not in values and key in {"LoadState", "FragmentPath", "DropInPaths", "Transient"},
                "SYSTEMD_UNIT_OBSERVATION_INVALID")
        values[key] = value
    require(len(values) == 4, "SYSTEMD_UNIT_OBSERVATION_INCOMPLETE")
    return values


def effective_owned_unit(unit):
    require(unit_metadata(unit) == {"LoadState": "loaded", "FragmentPath": str(UNIT_DIR / unit),
                                    "DropInPaths": "", "Transient": "no"}, "EFFECTIVE_SYSTEMD_UNIT_DRIFT")


def secure_directory(path):
    path = Path(path)
    require(not path.exists() and not path.is_symlink(), "OWNED_PATH_ALREADY_EXISTS")
    require(all(not parent.is_symlink() for parent in path.parents), "SYMLINK_PARENT_REFUSED")
    path.mkdir(mode=0o700, parents=True)


def write_new(path, data, mode=0o600):
    path = Path(path)
    secure_parents(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def save_receipt(receipt):
    temporary = RECEIPT.with_name(".installation." + uuid4().hex + ".tmp")
    try:
        write_new(temporary, encoded(receipt))
        os.replace(temporary, RECEIPT)
        directory = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def load_receipt(plan):
    receipt = json.loads(private_file(RECEIPT, 4 * 1024 * 1024))
    require(receipt.get("schema_version") == 1 and receipt.get("plan_sha256") == digest(encoded(plan)),
            "INSTALLATION_RECEIPT_MISMATCH")
    return receipt


def verify_owned_files(receipt):
    require(isinstance(receipt.get("files"), dict) and receipt["files"], "OWNERSHIP_RECEIPT_INCOMPLETE")
    for raw_path, expected in receipt["files"].items():
        path = Path(raw_path)
        secure_parents(path)
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == ROOT_UID and not info.st_mode & 0o022
                and file_digest(path) == expected, "OWNED_FILE_DRIFT")


def record_new_file(receipt, path, data, mode=0o600):
    # Persist intended ownership before writing; absent/partial files cause a hold.
    receipt["files"][str(path)] = digest(data)
    save_receipt(receipt)
    write_new(path, data, mode)


def kubectl(*args, input_bytes=None, timeout=20):
    return command([str(BINARY), "kubectl", "--kubeconfig=" + str(KUBECONFIG), "--request-timeout=8s", *args],
                   input_bytes=input_bytes, timeout=timeout)


def get_resource(resource, namespace=None):
    args = ["get", resource, "-o", "json"]
    if namespace:
        args += ["--namespace=" + namespace]
    return json.loads(kubectl(*args))


def wait_ready(test, seconds=300):
    deadline = time.monotonic() + seconds
    while True:
        try:
            test()
            return
        except (Refused, KeyError, ValueError, TypeError):
            require(time.monotonic() < deadline, "CLUSTER_READINESS_TIMEOUT")
            time.sleep(2)


def verify_node(plan, receipt, lock):
    nodes = get_resource("nodes")["items"]
    require(len(nodes) == 1, "SINGLE_NODE_CLUSTER_REQUIRED")
    node = nodes[0]
    require(node["metadata"]["name"] == receipt["node"], "CLUSTER_NODE_IDENTITY_MISMATCH")
    status = node["status"]
    require({item["address"] for item in status["addresses"] if item["type"] == "InternalIP"} == {plan["private_ip"]},
            "CLUSTER_NODE_ADDRESS_MISMATCH")
    require(status["nodeInfo"]["kubeletVersion"] == lock["k3s"]["version"], "CLUSTER_VERSION_MISMATCH")
    conditions = {item["type"]: item["status"] for item in status["conditions"]}
    require(conditions.get("Ready") == "True" and all(conditions.get(key) == "False" for key in
            ("DiskPressure", "MemoryPressure", "PIDPressure")), "CLUSTER_NODE_NOT_READY")


def verify_portainer(receipt, lock):
    expected, full = manifests(lock, receipt["node"])
    actual = {"kind": "List", "items": []}
    for desired in expected["items"]:
        actual["items"].append(get_resource(desired["kind"].lower() + "/" + desired["metadata"]["name"],
                                            desired["metadata"].get("namespace")))
    volume = get_resource("persistentvolume/" + VOLUME)
    storage = get_resource("storageclass/" + STORAGE_CLASS)
    portainer.verify(expected, actual, volume, storage)
    require(portainer.includes(full["items"][0], storage) and portainer.includes(full["items"][1], volume),
            "RETAINED_LOCAL_STORAGE_DRIFT")
    pods = get_resource("pods", "portainer")["items"]
    require(len(pods) == 1, "PORTAINER_POD_COUNT_INVALID")
    pod = pods[0]
    require(pod["spec"].get("nodeName") == receipt["node"] and not pod["spec"].get("hostNetwork"),
            "PORTAINER_POD_PLACEMENT_INVALID")
    statuses = pod.get("status", {}).get("containerStatuses", [])
    platform = {"aarch64": "arm64", "x86_64": "amd64"}[receipt["architecture"]]
    allowed = {lock["portainer"]["index_digest"], *lock["portainer"]["platforms"][platform].values()}
    require(len(statuses) == 1 and statuses[0].get("ready") is True
            and statuses[0].get("imageID", "").split("@")[-1].removeprefix("containerd://") in allowed,
            "PORTAINER_RUNNING_IMAGE_UNVERIFIED")
    services = get_resource("services", "portainer")["items"]
    require(len(services) == 1 and services[0]["metadata"]["name"] == "portainer", "UNEXPECTED_UI_SERVICE")
    require(not get_resource("ingresses", "portainer")["items"], "UI_INGRESS_REFUSED")


def verify_installation(plan, receipt, lock):
    verify_owned_files(receipt)
    for unit in (UNIT, FIREWALL_UNIT):
        effective_owned_unit(unit)
    require(private_file(KUBECONFIG, 1024 * 1024), "PRIVATE_KUBECONFIG_REQUIRED")
    verify_node(plan, receipt, lock)
    verify_portainer(receipt, lock)
    verify_network_policies(plan)
    verify_api_service(plan)
    verify_nftables_proxy()
    require(preflight.docker_snapshot() == receipt["docker"], "EXISTING_DOCKER_RUNTIME_CHANGED")
    require(snapshot_native_guards() == receipt["native_before"], "EXISTING_NATIVE_FIREWALL_CHANGED")
    require(native_digest(NATIVE_TABLE) == receipt.get("native_guard_sha256"), "PRIVATE_NATIVE_FIREWALL_DRIFT")
    require(snapshot_policy_routes() == receipt["policy_routes_before"], "EXISTING_POLICY_ROUTING_CHANGED")
    verify_firewall(plan, receipt["docker_subnets"], receipt["firewall_before"])
    rows = command(["ss", "--no-header", "--listening", "--numeric", "--tcp", "--udp"])
    required = {6443: plan["private_ip"], 10250: plan["private_ip"]}
    observed = {port: [] for port in required}
    for line in rows.splitlines():
        fields = line.split()
        require(len(fields) >= 5, "LISTENER_OBSERVATION_INVALID")
        endpoint = fields[4]
        address, _, raw_port = endpoint.rpartition(":")
        if raw_port.isdigit() and int(raw_port) in required:
            observed[int(raw_port)].append(address)
    require(all(observed[port] == [address] for port, address in required.items()),
            "PRIVATE_CLUSTER_LISTENERS_UNVERIFIED")
    return {"status": "FIRST_INSTALL_CONFIGURATION_AND_READINESS_PASS", "installed": True,
            "existing_docker_identity_preserved": True, "public_exposure_qualified": False,
            "owner_ui_login_verified": False, "backup_restore_verified": False,
            "application_migration_performed": False, "hardware_qualified": False,
            "portainer_scope": "kubernetes-only", "docker_environment_registered": False}


def hold_installation(receipt, reason):
    """Stop only a provably owned new unit. Never erase, uninstall or flush."""
    receipt["phase"] = "HELD_REVIEW_REQUIRED"
    receipt["failure_code"] = reason
    persisted, stop_attempted, stop_succeeded = False, False, False
    try:
        save_receipt(receipt)
        persisted = True
    except (OSError, Refused):
        pass
    path = UNIT_DIR / UNIT
    owned = receipt["files"].get(str(path))
    try:
        if owned and path.is_file() and not path.is_symlink() and file_digest(path) == owned:
            secure_parents(path)
            info = path.lstat()
            require(info.st_uid == ROOT_UID and not info.st_mode & 0o022, "OWNED_UNIT_CUSTODY_CHANGED")
            effective_owned_unit(UNIT)
            stop_attempted = True
            stop_succeeded = run(["systemctl", "disable", "--now", UNIT], timeout=90, allow_failure=True)[0] == 0
    except (OSError, Refused):
        pass
    # Stock K3s service stop does not guarantee its containerd workloads stopped.
    # Keep the restrictive firewall and all state. An operator must inspect the
    # owned CRI socket before any explicit cleanup; never call k3s-killall.sh.
    return {"status": "HELD_REVIEW_REQUIRED" if persisted else "HOLD_PERSISTENCE_FAILED",
            "reason": reason, "hold_persisted": persisted, "owned_unit_stop_attempted": stop_attempted,
            "owned_unit_stop_succeeded": stop_succeeded, "data_retained": True,
            "private_firewall_retained": True, "runtime_cleanup_requires_review": True}


def install(plan, facts, lock, maintenance_token):
    secure_directory(STATE)
    receipt = {"schema_version": 1, "phase": "PREPARING", "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
               "plan_sha256": digest(encoded(plan)), "release_lock_sha256": digest(encoded(lock)),
               "maintenance_token": maintenance_token,
               "node": facts["node"], "architecture": facts["observation"]["architecture"],
               "native_before": facts["native"],
               "policy_routes_before": facts["policy_routes"],
               "docker_subnets": facts["docker_subnets"], "firewall_before": facts["firewall"],
               "docker": preflight.docker_snapshot(), "files": {}}
    write_new(RECEIPT, encoded(receipt))
    try:
        secure_directory(CONFIG_DIR)
        secure_directory(DATA)
        secure_directory(LIB)
        secure_directory(STATE / "portainer")
        secure_directory(DATA / "agent" / "images")
        secure_directory(DATA / "server" / "manifests")
        record_new_file(receipt, STATE / "plan.json", encoded(plan))
        for filename in SOURCE_FILES:
            record_new_file(receipt, LIB / filename, (Path(__file__).parent / filename).read_bytes())
        shared_source = lifecycle_source().read_bytes()
        require(digest(shared_source) == lock["shared_lifecycle_sha256"], "SHARED_LIFECYCLE_SOURCE_DRIFT")
        record_new_file(receipt, LIB / "runtime_lifecycle.py", shared_source)
        record_new_file(receipt, CONFIG, encoded(configuration(plan, facts["node"], facts["interface"])))
        record_new_file(receipt, STATE / "resolv.conf", "".join("nameserver " + address + "\n"
                        for address in plan["dns_upstream_ipv4"]).encode())
        # Bootstrap policies are present before packaged workloads are started;
        # Portainer is admitted only after these exact policies are applied.
        # Namespace creation is declarative and does not change other namespaces.
        policy_bundle = network_policies(plan)
        policy_bundle["items"].insert(0, {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "portainer"}})
        record_new_file(receipt, DATA / "server" / "manifests" / "onesa-network-policy.json", encoded(policy_bundle))
        record_new_file(receipt, STATE / "private-firewall.nft", native_guard_source(plan, receipt["docker_subnets"]))
        # All release bytes are rehashed immediately before copying and then the
        # installed copies are hashed. No installer is downloaded or executed.
        platform = {"aarch64": "arm64", "x86_64": "amd64"}[receipt["architecture"]]
        for kind, destination in (("binary", BINARY), ("airgap", DATA / "agent" / "images" / facts["sources"]["airgap"].name)):
            data = verified_artifact_bytes(facts["sources"][kind], lock["k3s"]["platforms"][platform][kind])
            record_new_file(receipt, destination, data, 0o755 if kind == "binary" else 0o600)
        for name, contents in service_files().items():
            record_new_file(receipt, UNIT_DIR / name, contents.encode(), 0o644)
        verify_owned_files(receipt)
        require(preflight.docker_snapshot() == receipt["docker"], "EXISTING_DOCKER_RUNTIME_CHANGED")
        receipt["phase"] = "FILES_PREPARED"
        save_receipt(receipt)
        command(["systemctl", "daemon-reload"])
        for unit in (UNIT, FIREWALL_UNIT):
            effective_owned_unit(unit)
        ensure_native_guard(plan, receipt, first_install=True)
        apply_private_firewall(plan, receipt["docker_subnets"])
        verify_firewall(plan, receipt["docker_subnets"], receipt["firewall_before"])
        receipt["phase"] = "STARTING"
        save_receipt(receipt)
        command(["systemctl", "start", UNIT], timeout=360)
        wait_ready(lambda: verify_node(plan, receipt, lock))
        kubectl("apply", "--server-side", "--field-manager=onesa-first-install", "-f", "-", input_bytes=encoded(policy_bundle))
        expected, full = manifests(lock, receipt["node"])
        del expected
        receipt["phase"] = "APPLYING_PORTAINER"
        save_receipt(receipt)
        kubectl("apply", "--server-side", "--field-manager=onesa-first-install", "-f", "-", input_bytes=encoded(full))
        wait_ready(lambda: verify_portainer(receipt, lock))
        apply_private_firewall(plan, receipt["docker_subnets"])
        result = verify_installation(plan, receipt, lock)
        receipt["phase"] = "READY_OWNER_QUALIFICATION_REQUIRED"
        save_receipt(receipt)
        command(["systemctl", "enable", FIREWALL_UNIT, UNIT])
        return result
    except (Refused, OSError, ValueError, KeyError, TypeError, KeyboardInterrupt) as error:
        reason = str(error) if isinstance(error, Refused) else "INSTALLATION_INTERRUPTED"
        return hold_installation(receipt, reason)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("check", "install", "verify", "recover", "firewall", "serve"))
    parser.add_argument("--plan", required=True, help="Private root-owned JSON with observed target identity and network reservations")
    parser.add_argument("--artifacts", help="Root-owned directory containing the locked release binary and airgap archive")
    args = parser.parse_args()
    try:
        plan = validate_plan(json.loads(private_file(args.plan)))
        current_identity(plan)
        lock = releases()
        if args.action in {"verify", "recover", "firewall", "serve"} or RECEIPT.exists():
            receipt = load_receipt(plan)
            require(receipt["release_lock_sha256"] == digest(encoded(lock)), "RELEASE_LOCK_DRIFT")
            if args.action == "recover":
                module = lifecycle_module(lock)
                try:
                    with module.lifecycle_lock() as guard:
                        require(guard.active, "SHARED_HOST_LIFECYCLE_ENROLLMENT_REQUIRED")
                        token = guard.begin_hold(LEASE_KIND, LEASE_SCOPE, digest(encoded(plan)), resume=True)
                        receipt["maintenance_token"] = token
                        result = hold_installation(receipt, "OWNER_REQUESTED_HOLD")
                except module.LifecycleError as error:
                    raise Refused(str(error)) from None
            elif args.action in {"firewall", "serve"}:
                require(receipt["phase"] in {"FILES_PREPARED", "STARTING", "APPLYING_PORTAINER", "READY_OWNER_QUALIFICATION_REQUIRED"},
                        "INTERRUPTED_INSTALLATION_REQUIRES_REVIEW")
                verify_owned_files(receipt)
                check_service_lease(plan, receipt, lock)
                if args.action == "serve":
                    effective_owned_unit(UNIT)
                    clean_server_exec()
                    raise Refused("SERVER_EXEC_RETURNED")
                else:
                    ensure_native_guard(plan, receipt)
                    require(snapshot_policy_routes() == receipt["policy_routes_before"], "EXISTING_POLICY_ROUTING_CHANGED")
                    apply_private_firewall(plan, receipt["docker_subnets"])
                    verify_firewall(plan, receipt["docker_subnets"], receipt["firewall_before"])
                    result = {"status": "PRIVATE_FIREWALL_PASS"}
            else:
                require(receipt["phase"] == "READY_OWNER_QUALIFICATION_REQUIRED", "INTERRUPTED_INSTALLATION_REQUIRES_REVIEW")
                module = lifecycle_module(lock)
                try:
                    with module.lifecycle_lock() as guard:
                        require(guard.active, "SHARED_HOST_LIFECYCLE_ENROLLMENT_REQUIRED")
                        require(guard.read_hold() is None, "SHARED_HOST_MAINTENANCE_RECONCILIATION_REQUIRED")
                        result = verify_installation(plan, receipt, lock)
                        result["already_installed"] = True
                        result["shared_maintenance_hold_released"] = True
                except module.LifecycleError as error:
                    raise Refused(str(error)) from None
        else:
            require(args.action in {"check", "install"} and args.artifacts, "VERIFIED_ARTIFACT_DIRECTORY_REQUIRED")
            facts = collect_first_install(plan, args.artifacts, lock)
            if args.action == "check":
                result = {"status": "FIRST_INSTALL_PREREQUISITES_PASS", "installed": False,
                          "cloud_capacity_or_cost_approved": False, "application_migration_performed": False}
            else:
                module = lifecycle_module(lock)
                try:
                    with module.lifecycle_lock() as guard:
                        require(guard.active, "SHARED_HOST_LIFECYCLE_ENROLLMENT_REQUIRED")
                        require(guard.read_hold() is None, "SHARED_HOST_MAINTENANCE_IN_PROGRESS")
                        # Existing protocol requires global-before-component lock ordering.
                        secure_parents(LOCK)
                        fd = os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
                        with os.fdopen(fd, "w") as mutex:
                            info = os.fstat(mutex.fileno())
                            require(stat.S_ISREG(info.st_mode) and info.st_uid == ROOT_UID
                                    and not info.st_mode & 0o077 and info.st_nlink == 1, "INSTALL_LOCK_CUSTODY_INVALID")
                            fcntl.flock(mutex, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            facts = collect_first_install(plan, args.artifacts, lock)
                            token = guard.begin_hold(LEASE_KIND, LEASE_SCOPE, digest(encoded(plan)))
                            result = install(plan, facts, lock, token)
                            if result["status"].endswith("PASS"):
                                guard.complete_hold(token)
                                result["shared_maintenance_hold_released"] = True
                except module.LifecycleError as error:
                    raise Refused(str(error)) from None
    except Refused as error:
        result = {"status": "BLOCKED", "reason": str(error)}
    except (OSError, ValueError, KeyError, TypeError):
        result = {"status": "BLOCKED", "reason": "HOST_OR_INPUT_OBSERVATION_INCOMPLETE"}
    print(json.dumps(result, sort_keys=True))
    return 0 if result["status"].endswith("PASS") else 2


if __name__ == "__main__":
    raise SystemExit(main())
