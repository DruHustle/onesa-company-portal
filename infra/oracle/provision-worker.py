#!/usr/bin/env python3
"""Use an authenticated local OCI CLI or upload to Cloud Shell. Defaults to a read-only plan."""

import argparse
import base64
import configparser
import ipaddress
import json
import os
import re
import subprocess
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

NAME = "onesa-portal-worker"
SHAPE = "VM.Standard.A1.Flex"
TAGS = {"OnesaPurpose": "portal-worker", "OnesaEnvironment": "staging"}
CLOUD_INIT = """#cloud-config
ssh_pwauth: false
disable_root: true
package_update: true
packages:
  - ca-certificates
  - unattended-upgrades
write_files:
  - path: /etc/ssh/sshd_config.d/00-onesa-worker.conf
    owner: root:root
    permissions: '0644'
    content: |
      PasswordAuthentication no
      KbdInteractiveAuthentication no
      PermitRootLogin no
runcmd:
  - [sshd, -t]
  - [systemctl, try-reload-or-restart, ssh.service]
"""


class ProvisionError(RuntimeError):
    pass


class OciError(ProvisionError):
    def __init__(self, capacity=False, operation=None, code=None):
        self.capacity = capacity
        super().__init__("A1 host capacity unavailable" if capacity else
                         "OCI request failed" + (" for " + operation if operation else "") +
                         (" (" + code + ")" if code else "") +
                         ". Check CLI access/region and Console activity; no provider credentials are printed.")


class Oci:
    def __init__(self, region):
        self.region = region

    def request(self, command, *flags, payload=None, region=None):
        args = ["oci", "--region", region or self.region, "--output", "json",
                "--no-retry", "--connection-timeout", "10", "--read-timeout", "60",
                *command.split(), *flags]
        # No shell interpolation and no credentials in command-line arguments.
        with tempfile.TemporaryDirectory(prefix="onesa-oci-") as directory:
            if payload is not None:
                path = Path(directory) / "request.json"
                path.write_text(json.dumps(payload))
                path.chmod(0o600)
                args += ["--from-json", "file://" + str(path)]
            try:
                result = subprocess.run(args, capture_output=True, text=True, timeout=120)
            except subprocess.TimeoutExpired as error:
                raise ProvisionError("OCI request timed out; inspect Instances before retrying. No automatic relaunch.") from error
        if result.returncode:
            # Retry another AD only for Oracle's explicit out-of-host-capacity result.
            capacity = 'out of host capacity' in result.stderr.lower()
            code = re.search(r'"code"\s*:\s*"([A-Za-z][A-Za-z0-9]{0,63})"', result.stderr)
            raise OciError(capacity, command, code.group(1) if code else None)
        # OCI CLI emits no stdout for an empty paginated --all list.
        if command.endswith(" list") and not result.stdout.strip():
            return {"data": []}
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise ProvisionError("OCI returned an invalid JSON response for " + command) from error

    def get(self, command, *flags, **kwargs):
        return self.request(command, *flags, **kwargs)["data"]


def live(items):
    return [item for item in items if item.get("lifecycle-state") != "TERMINATED"]


def ssh_cidr(value):
    try:
        network = ipaddress.ip_network(value if "/" in value else value + "/32", strict=True)
    except ValueError as error:
        raise ProvisionError("Enter your Mac's public IPv4 address or exact /32 CIDR") from error
    if network.version != 4 or network.prefixlen != 32 or not network.network_address.is_global:
        raise ProvisionError("SSH requires a single public IPv4 /32; broad or private ranges are refused")
    return str(network)


def credentials_tenancy():
    config = configparser.ConfigParser()
    config.read(os.environ.get("OCI_CLI_CONFIG_FILE", str(Path.home() / ".oci/config")))
    return config.get(os.environ.get("OCI_CLI_PROFILE", "DEFAULT"), "tenancy", fallback=None)


def check_budget(ocpus, memory, storage, used_ocpu_hours=0, used_gb_hours=0,
                 remaining_hours=744, lag_hours=48):
    # Count stopped/provisioning instances and unattached volumes conservatively.
    if ocpus + 1 > 2 or memory + 6 > 12 or storage + 50 > 200:
        raise ProvisionError(
            f"Current allocation: {ocpus:g} A1 OCPUs / {memory:g} GB RAM / {storage:g} GB storage. "
            "Adding 1 OCPU / 6 GB RAM / 50 GB storage would exceed the conservative "
            "Always Free allocation (2 OCPUs / 12 GB / 200 GB)")
    if (used_ocpu_hours + ocpus * (remaining_hours + lag_hours) + remaining_hours > 1500 or
            used_gb_hours + memory * (remaining_hours + lag_hours) + 6 * remaining_hours > 9000):
        raise ProvisionError("Reported A1 usage plus projected remaining-month usage would exceed the free monthly allowance")


def monthly_usage(oci, tenancy, now):
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    following = (start + timedelta(days=32)).replace(day=1)
    used_cpu = used_memory = 0.0
    page = None
    while True:
        flags = ["--tenant-id", tenancy, "--granularity", "MONTHLY", "--query-type", "USAGE",
                 "--time-usage-started", start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                 "--time-usage-ended", following.strftime("%Y-%m-%dT%H:%M:%SZ"),
                 "--group-by", '["service","skuName","unit"]', "--is-aggregate-by-time", "true"]
        if page:
            flags += ["--page", page]
        result = oci.request("usage-api usage-summary request-summarized-usages", *flags)
        for row in result["data"]["items"]:
            sku = row.get("sku-name") or ""
            if not re.search(r"\bA1\b", sku, re.I):
                continue
            quantity = row.get("computed-quantity")
            if quantity is None or float(quantity) < 0:
                raise ProvisionError("A1 monthly usage is incomplete; verify it in Cost Analysis before provisioning")
            unit = (row.get("unit") or "").lower()
            if not any(marker in unit for marker in ("hour", "hr")):
                raise ProvisionError("Unrecognized A1 usage unit; no resources created")
            # Oracle's actual CPU SKU is "Standard - A1"; the unit identifies OCPUs.
            if "ocpu" in unit:
                used_cpu += float(quantity)
            elif "memory" in sku.lower() and ("gigabyte" in unit or "gb" in unit):
                used_memory += float(quantity)
            else:
                raise ProvisionError("Unrecognized A1 usage SKU; no resources created")
        page = result.get("opc-next-page")
        if not page:
            break
    return used_cpu, used_memory, (following - now).total_seconds() / 3600


def preflight(oci, tenancy, compartment):
    regions = oci.get("iam region-subscription list", "--tenancy-id", tenancy, "--all")
    homes = [r["region-name"] for r in regions if r["is-home-region"]]
    if homes != [oci.region]:
        raise ProvisionError("Selected region must be the tenancy home region for Always Free")
    compartments = [tenancy] + [c["id"] for c in oci.get(
        "iam compartment list", "--compartment-id", tenancy, "--compartment-id-in-subtree", "true",
        "--access-level", "ANY", "--all") if c["lifecycle-state"] == "ACTIVE"]
    if compartment not in compartments:
        raise ProvisionError("Target compartment is outside the active tenancy inventory")
    ads = oci.get("iam availability-domain list", "--compartment-id", tenancy, "--all")
    cpu = memory = storage = 0.0
    for region in regions:
        if region.get("status") != "READY":
            continue
        for cid in compartments:
            for instance in live(oci.get("compute instance list", "--compartment-id", cid,
                                         "--all", region=region["region-name"])):
                if instance.get("display-name") == NAME:
                    raise ProvisionError("An instance named onesa-portal-worker already exists; inspect it instead of creating another")
                if instance["shape"] == SHAPE:
                    cpu += instance["shape-config"]["ocpus"]
                    memory += instance["shape-config"]["memory-in-gbs"]
    for cid in compartments:
        for ad in ads:
            for volume in live(oci.get("bv boot-volume list", "--compartment-id", cid,
                                       "--availability-domain", ad["name"], "--all")):
                storage += volume["size-in-gbs"]
        for volume in live(oci.get("bv volume list", "--compartment-id", cid, "--all")):
            storage += volume["size-in-gbs"]
    now = datetime.now(timezone.utc)
    used_cpu, used_memory, remaining = monthly_usage(oci, tenancy, now)
    check_budget(cpu, memory, storage, used_cpu, used_memory, remaining)
    images = oci.get("compute image list", "--compartment-id", compartment,
                     "--operating-system", "Canonical Ubuntu", "--shape", SHAPE, "--all")
    for version in ("24.04", "22.04"):
        candidates = [i for i in images if i["lifecycle-state"] == "AVAILABLE"
                      and not i.get("compartment-id")
                      and i["operating-system-version"] == version
                      and i["display-name"].startswith("Canonical-Ubuntu-")
                      and "aarch64" in i["display-name"]]
        if candidates:
            image = max(candidates, key=lambda i: i["time-created"])
            break
    else:
        raise ProvisionError("No supported Ubuntu 24.04/22.04 ARM64 platform image available for A1")
    if not ads:
        raise ProvisionError("No availability domains returned")
    return ads, image, {"existing_a1_ocpus": cpu, "existing_a1_memory_gb": memory,
                        "existing_home_region_storage_gb": storage,
                        "reported_month_ocpu_hours": used_cpu, "reported_month_gb_hours": used_memory}


def matches(actual, expected):
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(matches(actual.get(k), v) for k, v in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(
            any(matches(item, wanted) for item in actual) for wanted in expected)
    return actual == expected


def network_resource(oci, kind, compartment, suffix, fields, filters=()):
    name = NAME + suffix
    listed = live(oci.get("network " + kind + " list", "--compartment-id", compartment,
                          *filters, "--all"))
    found = [item for item in listed if item["display-name"] == name]
    expected = {"compartment-id": compartment, "freeform-tags": TAGS, **fields}
    if found:
        if len(found) != 1 or found[0]["lifecycle-state"] != "AVAILABLE" or not matches(found[0], expected):
            raise ProvisionError("Existing " + kind + " does not match this worker's configuration; preserved without changes")
        return found[0]
    # CLI top-level camelCase input keys; nested rule keys retain API camelCase.
    payload = {"compartmentId": compartment, "displayName": name, "freeformTags": TAGS,
               "waitForState": ["AVAILABLE"], "waitIntervalSeconds": 2, "maxWaitSeconds": 90}
    for key, value in fields.items():
        parts = key.split("-")
        payload[parts[0] + "".join(part.title() for part in parts[1:])] = value
    return oci.get("network " + kind + " create", payload=payload)


def network(oci, compartment, cidr):
    vcn = network_resource(oci, "vcn", compartment, "-vcn", {"cidr-block": "10.72.0.0/16"})
    filters = ("--vcn-id", vcn["id"])
    gateway = network_resource(oci, "internet-gateway", compartment, "-internet",
                               {"vcn-id": vcn["id"], "is-enabled": True}, filters)
    routes = [{"destination": "0.0.0.0/0", "destinationType": "CIDR_BLOCK",
               "networkEntityId": gateway["id"]}]
    ingress = [{"protocol": "6", "source": cidr, "sourceType": "CIDR_BLOCK",
                "isStateless": False, "tcpOptions": {"destinationPortRange": {"min": 22, "max": 22}}},
               {"protocol": "1", "source": "0.0.0.0/0", "sourceType": "CIDR_BLOCK",
                "isStateless": False, "icmpOptions": {"type": 3, "code": 4}}]
    egress = [{"protocol": "all", "destination": "0.0.0.0/0", "destinationType": "CIDR_BLOCK",
               "isStateless": False}]
    # List/get responses use kebab-case even though request rule objects use camelCase.
    def response_keys(value):
        if isinstance(value, list):
            return [response_keys(v) for v in value]
        if isinstance(value, dict):
            return {re.sub(r"([A-Z])", r"-\1", k).lower(): response_keys(v) for k, v in value.items()}
        return value
    def ensure_rules(kind, suffix, rule_fields):
        name = NAME + suffix
        found = [i for i in live(oci.get("network " + kind + " list", "--compartment-id", compartment,
                                        *filters, "--all")) if i["display-name"] == name]
        expected = {"freeform-tags": TAGS, "vcn-id": vcn["id"], **response_keys(rule_fields)}
        if found:
            if len(found) != 1 or not matches(found[0], expected) or found[0]["lifecycle-state"] != "AVAILABLE":
                raise ProvisionError("Existing worker network rules differ; no changes applied")
            return found[0]
        return oci.get("network " + kind + " create", payload={"compartmentId": compartment,
                       "displayName": name, "freeformTags": TAGS, "vcnId": vcn["id"],
                       "waitForState": ["AVAILABLE"], "waitIntervalSeconds": 2,
                       "maxWaitSeconds": 90, **rule_fields})
    route = ensure_rules("route-table", "-routes", {"routeRules": routes})
    security = ensure_rules("security-list", "-ssh", {"ingressSecurityRules": ingress,
                                                      "egressSecurityRules": egress})
    # Attach only the restricted list. OCI's permissive default list is unused.
    return network_resource(oci, "subnet", compartment, "-subnet",
                            {"vcn-id": vcn["id"], "cidr-block": "10.72.1.0/24",
                             "route-table-id": route["id"], "security-list-ids": [security["id"]],
                             "prohibit-public-ip-on-vnic": False}, filters)


def public_key(path):
    key = path.read_text().strip()
    if "\n" in key or not re.fullmatch(r"ssh-(?:rsa|ed25519) [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?", key):
        raise ProvisionError("Expected one OpenSSH RSA or Ed25519 public key; never upload a private key")
    result = subprocess.run(["ssh-keygen", "-l", "-f", str(path)], capture_output=True)
    if result.returncode:
        raise ProvisionError("SSH public key is invalid")
    return key


def provision(oci, compartment, ads, image, cidr, directory, key_path=None):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    private = directory / (NAME + ".pem")
    if key_path:
        key = public_key(key_path)
        private = None
    else:
        if not private.exists():
            if private.with_suffix(".pem.pub").exists():
                raise ProvisionError("Public key exists without its private key; preserve it and supply a different key")
            subprocess.run(["ssh-keygen", "-q", "-t", "rsa", "-b", "3072", "-N", "",
                            "-C", NAME, "-f", str(private)], check=True, capture_output=True)
        private.chmod(0o600)
        key = public_key(Path(str(private) + ".pub"))
    subnet = network(oci, compartment, cidr)
    instance = None
    for ad in ads:
        print("Trying A1 capacity in " + ad["name"], flush=True)
        payload = {"compartmentId": compartment, "availabilityDomain": ad["name"],
                   "displayName": NAME, "freeformTags": TAGS, "shape": SHAPE,
                   "shapeConfig": {"ocpus": 1, "memoryInGBs": 6},
                   "sourceDetails": {"sourceType": "image", "imageId": image["id"],
                                     "bootVolumeSizeInGBs": 50, "bootVolumeVpusPerGB": 10},
                   # The CLI's extended launch command requires its top-level
                   # subnet option; it constructs CreateVnicDetails itself.
                   "subnetId": subnet["id"], "assignPublicIp": True,
                   "assignIpv6Ip": False, "assignPrivateDnsRecord": False,
                   "skipSourceDestCheck": False,
                   "instanceOptions": {"areLegacyImdsEndpointsDisabled": True},
                   "metadata": {"ssh_authorized_keys": key,
                                "user_data": base64.b64encode(CLOUD_INIT.encode()).decode()}}
        try:
            instance = oci.get("compute instance launch", payload=payload)
            break
        except OciError as error:
            if not error.capacity:
                raise
    if instance is None:
        raise ProvisionError("No A1 capacity in any home-region AD. Key/network retained for retry; no paid fallback")
    # Persist the OCID immediately, even when a subsequent readiness/readback fails.
    receipt = {"instance_ocid": instance["id"], "region": oci.region,
               "availability_domain": instance["availability-domain"],
               "operating_system": image["display-name"], "status": instance["lifecycle-state"],
               "shape": SHAPE, "ocpus": 1, "memory_gb": 6, "boot_volume_gb": 50,
               "ssh_source_cidr": cidr, "ssh_user": "ubuntu", "ssh_port": 22,
               "private_key_file": str(private) if private else "Use your existing private key",
               "public_ip": None, "configuration_verified": False}
    output = directory / "instance.json"
    output.write_text(json.dumps(receipt, indent=2) + "\n")
    output.chmod(0o600)
    for _ in range(90):
        instance = oci.get("compute instance get", "--instance-id", instance["id"])
        if instance["lifecycle-state"] == "RUNNING":
            break
        if instance["lifecycle-state"] != "PROVISIONING":
            raise ProvisionError("Instance did not reach RUNNING; inspect the OCID in " + str(output))
        time.sleep(10)
    else:
        raise ProvisionError("Instance still provisioning; OCID retained in " + str(output))
    attachments = oci.get("compute vnic-attachment list", "--compartment-id", compartment,
                          "--instance-id", instance["id"], "--all")
    vnics = [oci.get("network vnic get", "--vnic-id", a["vnic-id"])
             for a in attachments if a["lifecycle-state"] == "ATTACHED"]
    boots = oci.get("compute boot-volume-attachment list", "--compartment-id", compartment,
                   "--availability-domain", instance["availability-domain"],
                   "--instance-id", instance["id"], "--all")
    volumes = [oci.get("bv boot-volume get", "--boot-volume-id", b["boot-volume-id"])
               for b in boots if b["lifecycle-state"] == "ATTACHED"]
    if (instance["shape"] != SHAPE or instance["shape-config"]["ocpus"] != 1 or
            instance["shape-config"]["memory-in-gbs"] != 6 or len(vnics) != 1 or
            vnics[0]["subnet-id"] != subnet["id"] or vnics[0].get("nsg-ids") or
            not vnics[0].get("public-ip") or len(volumes) != 1 or
            volumes[0]["size-in-gbs"] != 50 or volumes[0]["vpus-per-gb"] != 10):
        raise ProvisionError("VM configuration readback failed; instance preserved for inspection")
    network(oci, compartment, cidr)  # Verify remote network rules before reporting success.
    receipt.update(status="RUNNING", public_ip=vnics[0]["public-ip"], configuration_verified=True)
    output.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))
    print("Receipt saved to " + str(output))
    if private:
        if os.environ.get("OCI_CLI_AUTH") == "instance_obo_user":
            print("Download and securely retain " + str(private) + " using Cloud Shell > Download.")
        else:
            print("Private SSH key retained locally at " + str(private) + " (permissions 0600).")
    print("VM created; worker/ClamAV installation and hosted acceptance are still pending.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Create the fixed Always Free-target VM and isolated network")
    parser.add_argument("--region", default="eu-frankfurt-1")
    parser.add_argument("--tenancy-id")
    parser.add_argument("--compartment-id", help="Defaults to the tenancy root; creates no IAM policies")
    parser.add_argument("--ssh-cidr", help="Your Mac's public IPv4 address or /32; never Cloud Shell's IP")
    parser.add_argument("--ssh-public-key-file", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path.home() / NAME)
    args = parser.parse_args()
    tenancy = args.tenancy_id or credentials_tenancy()
    if not tenancy or not tenancy.startswith("ocid1.tenancy."):
        raise ProvisionError("Tenancy not found in Cloud Shell config; supply --tenancy-id")
    cidr = ssh_cidr(args.ssh_cidr) if args.ssh_cidr else None
    key_path = args.ssh_public_key_file.expanduser() if args.ssh_public_key_file else None
    if key_path:
        public_key(key_path)
    oci = Oci(args.region)
    compartment = args.compartment_id or tenancy
    ads, image, usage = preflight(oci, tenancy, compartment)
    print(json.dumps({"name": NAME, "region": args.region, "compartment_id": compartment,
                      "image": image["display-name"], "shape": SHAPE, "ocpus": 1,
                      "memory_gb": 6, "boot_volume_gb": 50, "ssh_source_cidr": cidr,
                      "mode": "apply" if args.apply else "read-only plan", **usage}, indent=2))
    if not args.apply:
        print("No resources or keys created. Run again with --apply to provision.")
        return
    if cidr is None:
        cidr = ssh_cidr(input("Your Mac's public IPv4 address (not Cloud Shell's address): ").strip())
    provision(oci, compartment, ads, image, cidr, args.output_dir.expanduser(), key_path)


if __name__ == "__main__":
    try:
        main()
    except (ProvisionError, OSError, subprocess.SubprocessError, KeyError, ValueError) as error:
        if isinstance(error, ProvisionError):
            print("STOPPED: " + str(error))
        else:
            print("STOPPED: Local/configuration error; no private values are printed.")
        raise SystemExit(1)
