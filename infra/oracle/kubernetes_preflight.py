#!/usr/bin/env python3
"""Read-only, sanitized host observations for a first Onesa K3s installation.

This is not an installer, a capacity guarantee, or a release authorization. It
never reads application environment files, contacts cloud providers, or changes
Docker, firewall rules, packages, disks or systemd. Invoke only on the intended
host through the existing approved administrative route.
"""

import argparse
import datetime as dt
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess


MIB = 1024 ** 2
GIB = 1024 ** 3
CLUSTER_MEMORY_MIB = 2048
MANAGEMENT_MEMORY_MIB = 512
HOST_RESERVE_MIB = 1024
INSTALL_DISK_RESERVE_GIB = 10
CLUSTER_PORTS = {2379, 2380, 6443, 6444, 8472, 10248, 10250, 10256, 10257, 10259}
PRIVATE_NETWORKS = tuple(ipaddress.ip_network(x) for x in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
))
SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


class Refused(Exception):
    """A fixed diagnostic code; never include provider or subprocess output."""


def require(condition, code):
    if not condition:
        raise Refused(code)


def command(arguments):
    executable = shutil.which(arguments[0], path=SAFE_PATH)
    require(executable is not None, "REQUIRED_HOST_COMMAND_UNAVAILABLE")
    try:
        result = subprocess.run(
            [executable, *arguments[1:]], capture_output=True, timeout=10,
            check=False, env={"PATH": SAFE_PATH, "LANG": "C", "LC_ALL": "C"},
        )
    except (OSError, subprocess.TimeoutExpired):
        raise Refused("HOST_OBSERVATION_UNAVAILABLE") from None
    require(result.returncode == 0, "HOST_OBSERVATION_UNAVAILABLE")
    require(len(result.stdout) <= 2 * MIB, "HOST_OBSERVATION_TOO_LARGE")
    try:
        return result.stdout.decode("utf-8")
    except UnicodeError:
        raise Refused("HOST_OBSERVATION_INVALID") from None


def network(value):
    try:
        parsed = ipaddress.ip_network(value, strict=True)
    except (ValueError, TypeError):
        raise Refused("NETWORK_VALUE_INVALID") from None
    require(parsed.version == 4, "IPV4_NETWORK_REQUIRED")
    return parsed


def candidate_networks(pod_cidr, service_cidr):
    pods, services = network(pod_cidr), network(service_cidr)
    require(all(any(item.subnet_of(private) for private in PRIVATE_NETWORKS)
                for item in (pods, services)), "RFC1918_CLUSTER_NETWORKS_REQUIRED")
    require(16 <= pods.prefixlen <= 24 and 16 <= services.prefixlen <= 24,
            "CLUSTER_NETWORK_SIZE_INVALID")
    require(not pods.overlaps(services), "CLUSTER_NETWORKS_OVERLAP")
    return pods, services


def listener_ports(output):
    ports = set()
    for line in output.splitlines():
        fields = line.split()
        require(len(fields) >= 5 and fields[0] in {"tcp", "udp"},
                "LISTENER_OBSERVATION_INVALID")
        endpoint = fields[4]
        port = endpoint.rsplit(":", 1)[-1]
        require(port.isdigit() and 0 < int(port) <= 65535,
                "LISTENER_OBSERVATION_INVALID")
        ports.add(int(port))
    return sorted(ports)


def route_networks(rows):
    require(isinstance(rows, list), "ROUTE_OBSERVATION_INVALID")
    result = set()
    for row in rows:
        require(isinstance(row, dict), "ROUTE_OBSERVATION_INVALID")
        destination = row.get("dst")
        if destination in {None, "default", "0.0.0.0/0"}:
            continue
        result.add(str(network(destination)))
    return sorted(result)


def docker_networks(lines):
    result = set()
    try:
        for line in lines.splitlines():
            entries = json.loads(line)
            require(entries is None or isinstance(entries, list), "DOCKER_NETWORK_INVALID")
            for entry in entries or []:
                require(isinstance(entry, dict), "DOCKER_NETWORK_INVALID")
                subnet = entry.get("Subnet")
                if subnet:
                    parsed = ipaddress.ip_network(subnet, strict=True)
                    if parsed.version == 4:
                        result.add(str(parsed))
    except (ValueError, TypeError):
        raise Refused("DOCKER_NETWORK_INVALID") from None
    return sorted(result)


def docker_snapshot():
    base = ["docker", "--host", "unix:///var/run/docker.sock"]
    identifiers = command([*base, "ps", "--all", "--quiet", "--no-trunc"]).splitlines()
    require(len(identifiers) <= 256 and len(set(identifiers)) == len(identifiers)
            and all(re.fullmatch(r"[0-9a-f]{64}", item) for item in identifiers),
            "DOCKER_INVENTORY_INVALID")
    if not identifiers:
        return {"count": 0, "fingerprint": hashlib.sha256(b"[]").hexdigest()}
    # Explicit projection excludes Env, command arguments, labels and credentials.
    projection = "|".join("{{json ." + field + "}}" for field in (
        "Id", "Image", "State.StartedAt", "State.Running", "RestartCount",
    ))
    rows = command([*base, "inspect", "--format", projection, *sorted(identifiers)]).splitlines()
    require(len(rows) == len(identifiers), "DOCKER_INVENTORY_INCOMPLETE")
    observed = []
    try:
        for row in rows:
            values = [json.loads(value) for value in row.split("|")]
            require(len(values) == 5 and values[0] in identifiers
                    and isinstance(values[1], str)
                    and re.fullmatch(r"sha256:[0-9a-f]{64}", values[1])
                    and isinstance(values[2], str) and len(values[2]) <= 64
                    and isinstance(values[3], bool)
                    and type(values[4]) is int and values[4] >= 0,
                    "DOCKER_INVENTORY_INVALID")
            observed.append(values)
    except (ValueError, TypeError):
        raise Refused("DOCKER_INVENTORY_INVALID") from None
    require(sorted(value[0] for value in observed) == sorted(identifiers),
            "DOCKER_INVENTORY_INCOMPLETE")
    digest = hashlib.sha256(json.dumps(sorted(observed), separators=(",", ":")).encode()).hexdigest()
    return {"count": len(observed), "fingerprint": digest}


def memory_values(text):
    found = {}
    for line in text.splitlines():
        key, _, value = line.partition(":")
        if key in {"MemTotal", "MemAvailable"}:
            require(re.fullmatch(r"\s*\d+\s+kB\s*", value), "MEMORY_OBSERVATION_INVALID")
            found[key] = int(value.split()[0]) // 1024
    require(set(found) == {"MemTotal", "MemAvailable"}, "MEMORY_OBSERVATION_INCOMPLETE")
    return found


def collect():
    """Collect host-only facts. Failures cannot be silently treated as empty state."""
    require(platform.system() == "Linux", "LINUX_HOST_REQUIRED")
    require(os.geteuid() == 0, "ROOT_READ_ONLY_OBSERVATION_REQUIRED")
    require(Path("/proc/1/comm").read_text().strip() == "systemd"
            and not Path("/.dockerenv").exists()
            and not Path("/run/.containerenv").exists(), "SYSTEMD_HOST_REQUIRED")
    before = docker_snapshot()
    memory = memory_values(Path("/proc/meminfo").read_text())
    disk = shutil.disk_usage("/var/lib")
    machine_id = Path("/etc/machine-id").read_text().strip()
    require(re.fullmatch(r"[0-9a-f]{32}", machine_id) is not None, "HOST_IDENTITY_INVALID")
    controllers = Path("/sys/fs/cgroup/cgroup.controllers")
    if controllers.exists():
        cgroups = controllers.read_text().split()
    else:
        cgroups = [row.split()[0] for row in Path("/proc/cgroups").read_text().splitlines()
                   if not row.startswith("#") and len(row.split()) == 4 and row.split()[3] == "1"]
    cpu_count = len(os.sched_getaffinity(0))
    quota_path = Path("/sys/fs/cgroup/cpu.max")
    if quota_path.exists():
        quota, period = quota_path.read_text().split()
        if quota != "max":
            require(quota.isdigit() and period.isdigit() and int(period) > 0,
                    "CPU_QUOTA_INVALID")
            cpu_count = min(cpu_count, int(quota) / int(period))
    route_rows = json.loads(command(["ip", "-json", "-4", "route", "show", "table", "all"]))
    base = ["docker", "--host", "unix:///var/run/docker.sock"]
    ids = command([*base, "network", "ls", "--quiet", "--no-trunc"]).splitlines()
    require(len(ids) <= 256 and all(re.fullmatch(r"[0-9a-f]{64}", item) for item in ids),
            "DOCKER_NETWORK_INVENTORY_INVALID")
    subnets = docker_networks(command([*base, "network", "inspect", "--format",
                                     "{{json .IPAM.Config}}", *ids])) if ids else []
    ports = listener_ports(command(["ss", "--no-header", "--listening", "--numeric", "--tcp", "--udp"]))
    # Inspect rules without emitting addresses or changing the established chains.
    firewall = command(["iptables", "-S"])
    after = docker_snapshot()
    return {
        "machine_identity_sha256": hashlib.sha256(machine_id.encode()).hexdigest(),
        "architecture": platform.machine(),
        "cpu_capacity": cpu_count,
        "load_average_1m": os.getloadavg()[0],
        "memory_total_mib": memory["MemTotal"],
        "memory_available_mib": memory["MemAvailable"],
        "disk_free_gib": disk.free // GIB,
        "swap_active": len(Path("/proc/swaps").read_text().splitlines()) > 1,
        "cgroup_controllers": sorted(set(cgroups)),
        "ipv4_forwarding": Path("/proc/sys/net/ipv4/ip_forward").read_text().strip() == "1",
        "existing_cluster_paths": any(Path(path).exists() for path in (
            "/etc/rancher/k3s", "/var/lib/rancher/k3s", "/etc/kubernetes", "/var/lib/kubelet",
        )),
        "networks": sorted(set(route_networks(route_rows) + subnets)),
        "listener_ports": ports,
        "onesa_input_chain_present": "-N ONESA_WORKER_INPUT" in firewall,
        "docker_count": before["count"],
        "docker_runtime_identity_sha256": before["fingerprint"],
        "docker_runtime_identity_stable": before == after,
    }


def assess(observation, *, pod_cidr="10.42.0.0/16", service_cidr="10.43.0.0/16",
           workload_memory_mib=0, workload_disk_gib=0):
    """Evaluate measured facts; never certify an unmeasured application workload."""
    pods, services = candidate_networks(pod_cidr, service_cidr)
    require(type(workload_memory_mib) is int and 0 <= workload_memory_mib <= 1048576
            and type(workload_disk_gib) is int and 0 <= workload_disk_gib <= 1048576,
            "WORKLOAD_BUDGET_INVALID")
    memory_required = CLUSTER_MEMORY_MIB + MANAGEMENT_MEMORY_MIB + HOST_RESERVE_MIB + workload_memory_mib
    disk_required = INSTALL_DISK_RESERVE_GIB + workload_disk_gib
    blockers = []
    checks = (
        (observation["architecture"] in {"x86_64", "aarch64"}, "HOST_ARCHITECTURE_UNSUPPORTED"),
        (observation["cpu_capacity"] >= 2, "CPU_BELOW_CLUSTER_MINIMUM"),
        (observation["load_average_1m"] <= observation["cpu_capacity"] * 0.8, "CPU_HEADROOM_LOW"),
        (observation["memory_available_mib"] >= memory_required, "AVAILABLE_MEMORY_BELOW_BUDGET"),
        (observation["disk_free_gib"] >= disk_required, "DISK_RESERVE_BELOW_BUDGET"),
        (not observation["swap_active"], "ACTIVE_SWAP_REQUIRES_REVIEW"),
        ({"cpu", "memory", "pids"}.issubset(observation["cgroup_controllers"]), "REQUIRED_CGROUPS_MISSING"),
        (observation["ipv4_forwarding"], "IPV4_FORWARDING_DISABLED"),
        (not observation["existing_cluster_paths"], "EXISTING_CLUSTER_REQUIRES_OWN_UPGRADE_PATH"),
        (not set(observation["listener_ports"]) & CLUSTER_PORTS, "CLUSTER_PORTS_ALREADY_BOUND"),
        (not observation["onesa_input_chain_present"], "EXISTING_ONESA_FIREWALL_INTEGRATION_REQUIRED"),
        (observation["docker_runtime_identity_stable"], "DOCKER_RUNTIME_IDENTITY_CHANGED"),
    )
    blockers.extend(code for passed, code in checks if not passed)
    if any(candidate.overlaps(network(existing)) for candidate in (pods, services)
           for existing in observation["networks"]):
        blockers.append("CLUSTER_NETWORK_OVERLAP")
    return {
        "schema_version": 1,
        "observed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "scope": "host-prerequisites-only",
        "status": "BLOCKED" if blockers else "HOST_PREREQUISITES_PASS",
        "blockers": blockers,
        "installation_performed": False,
        "workload_capacity_qualified": False,
        "observations": {key: observation[key] for key in (
            "machine_identity_sha256", "architecture", "cpu_capacity", "load_average_1m",
            "memory_total_mib", "memory_available_mib", "disk_free_gib", "docker_count",
            "docker_runtime_identity_sha256", "docker_runtime_identity_stable",
        )},
        "candidate": {"pod_cidr": str(pods), "service_cidr": str(services),
                      "required_available_memory_mib": memory_required,
                      "required_free_disk_gib": disk_required},
        "preservation_contract": {
            "existing_ingress_ports": sorted(set(observation["listener_ports"]) & {80, 443}),
            "initial_traefik_and_servicelb_disabled": True,
            "existing_compose_and_firewall_unchanged": True,
            "public_control_ports": False,
            "new_paid_resources": False,
        },
        "unverified": ["approved-host-identity", "provider-and-host-firewall-integration",
                       "exact-release-and-image-qualification", "retained-persistent-storage",
                       "independent-backup-and-restore", "application-migration-and-rollback",
                       "docker-configuration-mount-and-network-preservation"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pod-cidr", default="10.42.0.0/16")
    parser.add_argument("--service-cidr", default="10.43.0.0/16")
    parser.add_argument("--workload-memory-mib", type=int, default=0)
    parser.add_argument("--workload-disk-gib", type=int, default=0)
    args = parser.parse_args()
    try:
        candidate_networks(args.pod_cidr, args.service_cidr)
        report = assess(collect(), pod_cidr=args.pod_cidr, service_cidr=args.service_cidr,
                        workload_memory_mib=args.workload_memory_mib,
                        workload_disk_gib=args.workload_disk_gib)
    except Refused as error:
        report = {"schema_version": 1, "status": "BLOCKED", "blockers": [str(error)],
                  "installation_performed": False}
    except (OSError, ValueError, KeyError, TypeError):
        report = {"schema_version": 1, "status": "BLOCKED",
                  "blockers": ["HOST_OBSERVATION_INCOMPLETE"], "installation_performed": False}
    print(json.dumps(report, indent=2, sort_keys=True))
    return 2 if report["status"] == "BLOCKED" else 0


if __name__ == "__main__":
    raise SystemExit(main())
