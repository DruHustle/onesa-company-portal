"""Synthetic first-install/recovery tests; never contact IMDS, Docker or systemd."""

import contextlib
import copy
import io
import ipaddress
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "infra/oracle"))
import k3s_first_install as installer
import oracle_k3s_network_acceptance as acceptance


def plan():
    return {"instance_id": "ocid1.instance.oc1.test." + "a" * 32,
            "machine_id_sha256": installer.digest(b"synthetic-machine"),
            "private_ip": "10.12.0.3", "pod_cidr": "10.120.0.0/16", "service_cidr": "10.121.0.0/16",
            "reserved_cidrs": ["10.12.0.0/16", "172.18.0.0/16", "100.64.0.0/10"],
            "dns_upstream_ipv4": ["169.254.169.254"], "workload_memory_mib": 0, "workload_disk_gib": 0}


def firewall():
    text = """*filter
:INPUT DROP [0:0]
:FORWARD DROP [0:0]
:OUTPUT ACCEPT [0:0]
:ONESA_WORKER_INPUT - [0:0]
:DOCKER-USER - [0:0]
-A INPUT -j ONESA_WORKER_INPUT
-A FORWARD -i tailscale0 -j DROP
-A FORWARD -j DOCKER-USER
-A ONESA_WORKER_INPUT -i lo -j ACCEPT
-A ONESA_WORKER_INPUT -i tailscale0 -j DROP
-A ONESA_WORKER_INPUT -j DROP
-A DOCKER-USER -i eth0 -m conntrack --ctstate NEW -j DROP
-A DOCKER-USER -j RETURN
COMMIT
"""
    return {family: installer.parse_rules(text) for family in ("iptables", "ip6tables")}


def installed_rules(before=None):
    result = copy.deepcopy(before) if before is not None else firewall()
    for family, chains in installer.firewall_rules(plan(), ["172.18.0.0/16"]).items():
        current = result[family]["filter"]
        for name, rules in chains.items():
            current["chains"][name] = "-"
            current["rules"].extend([["-A", name, *rule] for rule in rules])
            parent = "INPUT" if name == installer.INPUT_CHAIN else "FORWARD"
            current["rules"].insert(0, ["-A", parent, "-j", name])
    return result


class PlanTests(unittest.TestCase):
    def test_requires_exact_private_target_and_excludes_source_even_if_id_matches(self):
        data = installer.validate_plan(plan())
        identity = {"id": data["instance_id"], "displayName": "Onesa UG Backend"}
        installer.match_identity(data, identity, data["machine_id_sha256"])
        for field, value, expected in (("id", data["instance_id"] + "b", "WRONG_OCI_INSTANCE"),
                                       ("displayName", "Software Engineering Backend", "ONESA_DESTINATION_IDENTITY_REQUIRED")):
            bad = {**identity, field: value}
            with self.assertRaisesRegex(installer.Refused, expected):
                installer.match_identity(data, bad, data["machine_id_sha256"])
        with self.assertRaisesRegex(installer.Refused, "WRONG_MACHINE_IDENTITY"):
            installer.match_identity(data, identity, "b" * 64)

    def test_network_and_schema_refusals(self):
        cases = [{"private_ip": "203.0.113.9"}, {"pod_cidr": "10.12.0.0/16"},
                 {"service_cidr": "10.120.1.0/24"}, {"reserved_cidrs": []},
                 {"reserved_cidrs": ["172.18.0.0/16"]}, {"workload_memory_mib": True}, {"extra": True}]
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(installer.Refused):
                installer.validate_plan({**plan(), **changes})

    def test_private_configuration_preserves_compose_ingress_and_uses_containerd(self):
        settings = installer.configuration(plan(), "onesa-test", "ens3")
        self.assertEqual(settings["bind-address"], plan()["private_ip"])
        self.assertEqual(settings["advertise-address"], settings["bind-address"])
        self.assertEqual(settings["node-ip"], settings["bind-address"])
        self.assertEqual(settings["disable"], ["traefik", "servicelb", "local-storage"])
        self.assertEqual(settings["flannel-backend"], "host-gw")
        self.assertEqual(settings["write-kubeconfig-mode"], "0600")
        self.assertNotIn("docker", settings)
        self.assertNotIn("flannel-external-ip", settings)
        self.assertIn("nodeport-addresses=127.0.0.0/8", settings["kube-proxy-arg"])
        self.assertIn("proxy-mode=nftables", settings["kube-proxy-arg"])
        self.assertEqual(settings["resolv-conf"], str(installer.STATE / "resolv.conf"))

    def test_upstream_dns_requires_observed_nonloopback_ipv4_without_provider_substitution(self):
        for upstream in ([], ["127.0.0.53"], ["::1"], ["10.120.0.2"], ["224.0.0.1"],
                         ["169.254.169.254", "169.254.169.254"]):
            with self.subTest(upstream=upstream), self.assertRaises(installer.Refused):
                installer.validate_plan({**plan(), "dns_upstream_ipv4": upstream})
        with patch.object(installer.Path, "is_file", return_value=True), \
                patch.object(installer.Path, "read_text", return_value="nameserver 169.254.169.254\n"):
            installer.require_observed_dns(plan())
            with self.assertRaisesRegex(installer.Refused, "DNS_CHANGED_OR_UNAPPROVED"):
                installer.require_observed_dns({**plan(), "dns_upstream_ipv4": ["192.0.2.53"]})

    def test_release_lock_excludes_prerelease_and_has_real_architecture_hashes(self):
        lock = installer.releases()
        self.assertFalse(lock["k3s"]["prerelease"])
        self.assertEqual(lock["k3s"]["version"], "v1.36.5+k3s1")
        for platform in lock["k3s"]["platforms"].values():
            for artifact in platform.values():
                self.assertRegex(artifact["sha256"], r"^[0-9a-f]{64}$")
                self.assertGreater(artifact["size"], 1000000)
                self.assertTrue(artifact["url"].startswith("https://github.com/k3s-io/k3s/releases/download/"))
        self.assertEqual(set(lock["portainer"]["platforms"]), {"arm64", "amd64"})

    def test_storage_is_retained_local_and_never_mounts_docker(self):
        base, full = installer.manifests(installer.releases(), "onesa-test")
        storage, volume = full["items"][:2]
        self.assertEqual(storage["reclaimPolicy"], "Retain")
        self.assertEqual(volume["spec"]["persistentVolumeReclaimPolicy"], "Retain")
        self.assertEqual(volume["spec"]["local"]["path"], str(installer.STATE / "portainer"))
        self.assertNotIn("docker.sock", json.dumps(full))
        self.assertNotIn("NodePort", json.dumps(full))
        self.assertEqual(installer.portainer.by_kind(base["items"], "Service")["spec"]["type"], "ClusterIP")

    def test_server_launcher_excludes_ambient_credentials_and_proxy_settings(self):
        ambient = {"NOTIFY_SOCKET": "/run/systemd/notify", "K3S_URL": "https://unexpected.example.test",
                   "K3S_TOKEN": "synthetic-token", "HTTP_PROXY": "http://unexpected.example.test"}
        with patch.dict(installer.os.environ, ambient, clear=True), patch.object(installer.os, "execve") as execute:
            installer.clean_server_exec()
        binary, arguments, environment = execute.call_args.args
        self.assertEqual(binary, installer.BINARY)
        self.assertEqual(arguments, [str(installer.BINARY), "server", "--config", str(installer.CONFIG)])
        self.assertEqual(set(environment), {"PATH", "LANG", "LC_ALL", "NOTIFY_SOCKET"})
        self.assertNotIn("synthetic-token", repr(environment))


class BridgePrerequisiteTests(unittest.TestCase):
    def test_missing_disabled_and_unreadable_bridge_prerequisites_are_distinct(self):
        for observed, reason in ((FileNotFoundError(), "MISSING"), (PermissionError(), "UNREADABLE"),
                                 ("0\n", "DISABLED"), ("unexpected\n", "INVALID")):
            arguments = {"side_effect": observed} if isinstance(observed, Exception) else {"return_value": observed}
            with self.subTest(reason=reason), patch.object(installer.Path, "read_text", **arguments), \
                    self.assertRaisesRegex(installer.Refused, "BRIDGE_NETFILTER_SYSCTL_" + reason + ":bridge-nf-call-iptables"):
                installer.require_bridge_netfilter()
        with patch.object(installer.Path, "read_text", side_effect=["1\n", FileNotFoundError()]), \
                self.assertRaisesRegex(installer.Refused, "BRIDGE_NETFILTER_SYSCTL_MISSING:bridge-nf-call-ip6tables"):
            installer.require_bridge_netfilter()
        with patch.object(installer.Path, "read_text", return_value="1\n"):
            self.assertEqual(installer.require_bridge_netfilter(),
                             {"bridge-nf-call-iptables": 1, "bridge-nf-call-ip6tables": 1})

    def test_parent_refuses_missing_bridge_filter_before_any_namespace_or_packet_work(self):
        output = io.StringIO()
        with patch.object(sys, "argv", ["acceptance"]), patch.object(acceptance.os, "geteuid", return_value=0), \
                patch.object(acceptance, "source_pins", return_value={"synthetic": "a" * 64}), \
                patch.object(installer.Path, "read_text", side_effect=FileNotFoundError()), \
                patch.object(acceptance, "fingerprints") as fingerprint, \
                patch.object(acceptance.subprocess, "run") as execute, contextlib.redirect_stdout(output):
            self.assertEqual(acceptance.main(), 2)
        fingerprint.assert_not_called()
        execute.assert_not_called()
        result = json.loads(output.getvalue())
        self.assertEqual(result["phase"], "PARENT_BRIDGE_PREREQUISITES")
        self.assertEqual(result["reason"], "BRIDGE_NETFILTER_SYSCTL_MISSING:bridge-nf-call-iptables")
        self.assertFalse(result["namespace_creation_attempted"])
        self.assertFalse(result["isolated_child_verified"])
        self.assertFalse(result["packet_cases_started"])
        self.assertFalse(result["installation_performed"])
        self.assertNotIn("host_network_configuration_unchanged", result)

    def test_child_rechecks_bridge_prerequisite_before_first_isolated_mutation(self):
        progress = {}
        parent = {"namespaces": {name: "parent" for name in ("net", "mnt", "pid")},
                  "source_sha256": {"synthetic": "a" * 64}}
        with patch.object(acceptance.os, "geteuid", return_value=0), patch.object(acceptance.os, "getpid", return_value=1), \
                patch.object(acceptance.os, "readlink", return_value="child"), \
                patch.object(acceptance, "source_pins", return_value=parent["source_sha256"]), \
                patch.object(installer.Path, "read_text", return_value="0\n"), \
                patch.object(acceptance, "run") as execute, self.assertRaisesRegex(acceptance.Failed, "SYSCTL_DISABLED"):
            acceptance.child(parent, progress)
        execute.assert_not_called()
        self.assertEqual(progress["phase"], "CHILD_BRIDGE_PREREQUISITES")
        self.assertTrue(progress["isolated_child_verified"])


class FirewallTests(unittest.TestCase):
    def test_mark_reservation_refuses_existing_netfilter_consumers_and_output_restrictions(self):
        installer.require_netpol_mark_reservation(firewall(), "table inet retained { chain input { } }")
        for rule in (["-A", "FORWARD", "-m", "mark", "--mark", "0x80000/0xff0000", "-j", "ACCEPT"],
                     ["-A", "FORWARD", "-j", "CONNMARK", "--restore-mark"],
                     ["-A", "OUTPUT", "-j", "DROP"]):
            changed = firewall()
            changed["iptables"]["filter"]["rules"].append(rule)
            with self.subTest(rule=rule), self.assertRaises(installer.Refused):
                installer.require_netpol_mark_reservation(changed, "")
        with self.assertRaisesRegex(installer.Refused, "NETFILTER_MARK"):
            installer.require_netpol_mark_reservation(firewall(), "meta mark & 0xff0000 == 0x80000 accept")

    def test_actual_builtin_netpol_accept_is_authorized_but_generic_parent_accept_is_not(self):
        before, after = firewall(), installed_rules()
        comment = "KUBE-ROUTER rule to explicitly ACCEPT traffic that comply to network policies"
        parent_rule = ["-A", "FORWARD", "-m", "comment", "--comment", comment,
                       "-m", "mark", "--mark", "0x20000/0x20000", "-j", "ACCEPT"]
        after["iptables"]["filter"]["rules"].insert(0, parent_rule)
        installer.preserved_firewall(before, after)
        with patch.object(installer, "snapshot_firewall", return_value=after):
            installer.verify_firewall(plan(), ["172.18.0.0/16"], before)
        for index, value in ((5, "unrelated controller"), (9, "0x4000/0x4000")):
            changed = copy.deepcopy(after)
            changed["iptables"]["filter"]["rules"][0][index] = value
            with self.subTest(value=value), self.assertRaises(installer.Refused):
                installer.preserved_firewall(before, changed)

    def test_actual_controller_dispatch_can_reconcile_but_must_keep_exact_pod_scope(self):
        before, after = firewall(), installed_rules()
        current = after["iptables"]["filter"]
        current["chains"].update({"KUBE-ROUTER-FORWARD": "-", "KUBE-POD-FW-ABC": "-"})
        current["rules"].insert(0, ["-A", "FORWARD", "-m", "comment", "--comment", "kube-router netpol - ABC",
                                    "-j", "KUBE-ROUTER-FORWARD"])
        selector = ["-A", "KUBE-ROUTER-FORWARD", "-d", "10.120.0.3/32", "-j", "KUBE-POD-FW-ABC"]
        current["rules"].append(selector)
        with patch.object(installer, "snapshot_firewall", return_value=after):
            installer.verify_firewall(plan(), ["172.18.0.0/16"], before)
        for changed in ("0.0.0.0/0", "172.18.0.3/32", "10.120.0.0/16"):
            selector[3] = changed
            with self.subTest(changed=changed), self.assertRaisesRegex(installer.Refused, "POLICY_FORWARD_SCOPE"):
                installer.verify_scoped_forward_controllers(after, plan())

    def test_iptables_proxy_is_refused_even_when_its_jump_follows_our_guard(self):
        state = installed_rules()
        state["iptables"]["filter"]["chains"]["KUBE-FORWARD"] = "-"
        with self.assertRaisesRegex(installer.Refused, "IPTABLES_KUBE_PROXY_REFUSED"):
            installer.verify_scoped_forward_controllers(state, plan())

    def test_pods_cannot_inherit_existing_docker_accepts(self):
        docker_policy = [["-s", "10.0.0.0/8", "-j", "ACCEPT"], ["-j", "RETURN"]]
        original_policy = copy.deepcopy(docker_policy)
        chains = installer.firewall_rules(plan(), ["172.18.0.0/16", "192.168.40.0/24"])["iptables"]
        chains["DOCKER-USER"] = docker_policy

        def verdict(chain, interface, source, destination, out_interface="br-existing"):
            for rule in chains[chain]:
                if "-i" in rule and rule[rule.index("-i") + 1] != interface:
                    continue
                if "-o" in rule and rule[rule.index("-o") + 1] != out_interface:
                    continue
                if "--ctstate" in rule:
                    continue  # These requests initiate new connections.
                if any(flag in rule and ipaddress.ip_address(address) not in
                       ipaddress.ip_network(rule[rule.index(flag) + 1])
                       for flag, address in (("-s", source), ("-d", destination))):
                    continue
                target = rule[rule.index("-j") + 1]
                if target in {"ACCEPT", "DROP", "RETURN"}:
                    return target
                result = verdict(target, interface, source, destination, out_interface)
                if result != "RETURN":
                    return result
            return "RETURN"

        for destination in ("172.18.0.2", "192.168.40.2"):
            self.assertEqual(verdict(installer.FORWARD_CHAIN, "cni0", "10.120.0.2", destination), "DROP")
        for destination in ("10.120.0.2", "10.121.0.2"):
            self.assertEqual(verdict(installer.FORWARD_CHAIN, "tailscale0", "100.64.0.2", destination), "DROP")
        self.assertEqual(verdict(installer.FORWARD_CHAIN, "tailscale0", "100.64.0.2", "203.0.113.2", "cni0"), "DROP")
        self.assertEqual(verdict(installer.FORWARD_CHAIN, "tailscale0", "100.64.0.2", "203.0.113.2"), "RETURN")
        self.assertEqual(verdict(installer.FORWARD_CHAIN, "br-existing", "10.12.0.2", "172.18.0.2"), "RETURN")
        self.assertEqual(verdict(installer.FORWARD_CHAIN, "cni0", "10.120.0.2", "203.0.113.2"), "ACCEPT")
        self.assertEqual(verdict(installer.FORWARD_CHAIN, "br-existing", "192.0.2.2", "172.18.0.2"), "RETURN")
        self.assertEqual(docker_policy, original_policy)

    def test_existing_policy_survives_and_docker_edits_are_rejected(self):
        before, after = firewall(), installed_rules()
        installer.require_existing_firewall(before)
        installer.preserved_firewall(before, after)
        changed = copy.deepcopy(after)
        changed["iptables"]["filter"]["rules"].remove(["-A", "DOCKER-USER", "-j", "RETURN"])
        with self.assertRaisesRegex(installer.Refused, "EXISTING_FIREWALL_CHANGED"):
            installer.preserved_firewall(before, changed)
        changed = copy.deepcopy(after)
        changed["iptables"]["filter"]["chains"]["FORWARD"] = "ACCEPT"
        with self.assertRaisesRegex(installer.Refused, "EXISTING_FIREWALL_CHANGED"):
            installer.preserved_firewall(before, changed)

    def test_api_and_kubelet_accept_only_loopback_or_local_pods(self):
        desired = installer.firewall_rules(plan(), ["172.18.0.0/16"])
        v4 = desired["iptables"][installer.INPUT_CHAIN]
        accepts = [row for row in v4 if row[-1] == "ACCEPT"]
        self.assertEqual(len(accepts), 2)
        self.assertTrue(all(row[:6] == ["-s", plan()["pod_cidr"], "-d", plan()["private_ip"] + "/32", "-i", "cni0"] for row in accepts))
        forward = desired["iptables"][installer.FORWARD_CHAIN]
        self.assertEqual(forward[-4:], [
            ["-d", plan()["pod_cidr"], "-j", "DROP"],
            ["-d", plan()["service_cidr"], "-j", "DROP"],
            ["-o", "cni0", "-j", "DROP"], ["-j", "RETURN"],
        ])
        self.assertIn(["-i", "cni0", "-j", "DOCKER-USER"], forward)
        self.assertIn(["-i", "cni0", "-j", "RETURN"], forward)
        self.assertIn(["-d", "172.18.0.0/16", "-i", "cni0", "-j", "DROP"], forward)
        self.assertFalse(any(row[-1] == "ACCEPT" for row in forward))
        self.assertEqual(desired["ip6tables"][installer.FORWARD_CHAIN], [["-j", "RETURN"]])
        self.assertNotIn("51820", json.dumps(desired))

    def test_existing_owner_tunnels_keep_their_actual_forward_rule_order(self):
        # Synthetic addresses preserve the deployed rule shape: each owner/peer
        # pair has TCP, echo, related ICMP and conntrack-bound reply permits
        # before the original blanket overlay drop. No private host data is used.
        owner, peers = "100.64.10.2", ("10.90.254.2", "10.90.254.3")
        before = firewall()
        table = before["iptables"]["filter"]
        permissions = []
        for peer in peers:
            common = ["-i", "tailscale0", "-o", "owner-hub", "-s", owner + "/32", "-d", peer + "/32"]
            permissions += [
                [*common, "-p", "tcp", "-m", "multiport", "--dports", "22,80,8291",
                 "-m", "conntrack", "--ctstate", "NEW,ESTABLISHED", "-j", "ACCEPT"],
                [*common, "-p", "icmp", "--icmp-type", "echo-request",
                 "-m", "conntrack", "--ctstate", "NEW,ESTABLISHED", "-j", "ACCEPT"],
                [*common, "-p", "icmp", "-m", "conntrack", "--ctstate", "RELATED", "-j", "ACCEPT"],
                ["-i", "owner-hub", "-o", "tailscale0", "-s", peer + "/32", "-d", owner + "/32",
                 "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "--ctorigsrc", owner + "/32",
                 "--ctorigdst", peer + "/32", "-j", "ACCEPT"],
            ]
        # An existing non-overlay permit must not be preempted by the new
        # DOCKER-USER jump either; that chain deliberately rejects this ingress.
        permissions.append(["-i", "eth0", "-o", "br-existing", "-s", "192.0.2.10/32",
                            "-d", "172.18.0.2/32", "-p", "tcp", "--dport", "443", "-j", "ACCEPT"])
        table["rules"][1:1] = [["-A", "FORWARD", *rule] for rule in permissions]
        after = installed_rules(before)
        # Kubernetes/Flannel can accept cluster traffic before the legacy parent
        # chain is reached. The new guard must protect this real ordering too.
        table = after["iptables"]["filter"]
        table["chains"]["FLANNEL-FWD"] = "-"
        jump = table["rules"].index(["-A", "FORWARD", "-j", installer.FORWARD_CHAIN])
        table["rules"].insert(jump + 1, ["-A", "FORWARD", "-j", "FLANNEL-FWD"])
        table["rules"] += [["-A", "FLANNEL-FWD", "-d", plan()["pod_cidr"], "-j", "ACCEPT"],
                           ["-A", "FLANNEL-FWD", "-s", plan()["pod_cidr"], "-j", "ACCEPT"]]
        installer.require_existing_firewall(before)
        installer.preserved_firewall(before, after)

        def verdict(snapshot, packet, family="iptables"):
            state = snapshot[family]["filter"]

            def traverse(chain):
                for row in state["rules"]:
                    if row[1] != chain:
                        continue
                    rule, matched, offset = row[2:], True, 0
                    while offset < len(rule):
                        flag, value = rule[offset:offset + 2]
                        offset += 2
                        if flag == "-j":
                            if not matched:
                                break
                            if value in {"ACCEPT", "DROP", "RETURN"}:
                                return value
                            result = traverse(value)
                            if result != "RETURN":
                                return result
                            break
                        if flag == "-m":
                            self.assertIn(value, {"conntrack", "multiport", "tcp", "udp"})
                        elif flag in {"-s", "-d", "--ctorigsrc", "--ctorigdst"}:
                            address = packet.get(flag)
                            matched &= address is not None and ipaddress.ip_address(address) in ipaddress.ip_network(value)
                        elif flag == "--ctstate":
                            matched &= packet.get(flag) in value.split(",")
                        elif flag == "--dports":
                            matched &= str(packet.get("--dport")) in value.split(",")
                        else:
                            self.assertIn(flag, {"-i", "-o", "-p", "--dport", "--icmp-type", "--ctdir"})
                            matched &= str(packet.get(flag)) == value
                return "RETURN"

            result = traverse("FORWARD")
            return state["chains"]["FORWARD"] if result == "RETURN" else result

        for peer in peers:
            request = {"-i": "tailscale0", "-o": "owner-hub", "-s": owner, "-d": peer,
                       "-p": "tcp", "--dport": 22, "--ctstate": "NEW"}
            permitted = [{**request, "--dport": port} for port in (22, 80, 8291)]
            permitted += [{**request, "-p": "icmp", "--icmp-type": "echo-request"},
                          {**request, "-p": "icmp", "--icmp-type": "destination-unreachable", "--ctstate": "RELATED"},
                          {**request, "-i": "owner-hub", "-o": "tailscale0", "-s": peer, "-d": owner,
                           "--ctstate": "ESTABLISHED", "--ctorigsrc": owner, "--ctorigdst": peer}]
            denied = [{**request, "-s": "100.64.10.99"}, {**request, "-d": "10.90.254.99"},
                      {**request, "--dport": 23}, {**request, "-o": "br-existing"},
                      {**permitted[-1], "--ctorigsrc": "100.64.10.99"}]
            for packet, expected in [(p, "ACCEPT") for p in permitted] + [(p, "DROP") for p in denied]:
                with self.subTest(packet=packet):
                    self.assertEqual(verdict(before, packet), expected)
                    self.assertEqual(verdict(after, packet), expected)
            for destination in ("10.120.0.2", "10.121.0.10"):
                self.assertEqual(verdict(after, {**request, "-d": destination, "-o": "cni0"}), "DROP")
        permitted = {"-i": "eth0", "-o": "br-existing", "-s": "192.0.2.10", "-d": "172.18.0.2",
                     "-p": "tcp", "--dport": 443, "--ctstate": "NEW"}
        self.assertEqual(verdict(before, permitted), "ACCEPT")
        self.assertEqual(verdict(after, permitted), "ACCEPT")
        pod_request = {"-i": "cni0", "-o": "eth0", "-s": "10.120.0.7", "-d": "203.0.113.5",
                       "-p": "tcp", "--dport": 443, "--ctstate": "NEW", "--ctdir": "ORIGINAL"}
        reply = {**pod_request, "-i": "eth0", "-o": "cni0", "-s": "203.0.113.5", "-d": "10.120.0.7",
                 "--ctstate": "ESTABLISHED", "--ctdir": "REPLY", "--ctorigsrc": "10.120.0.7", "--ctorigdst": "203.0.113.5"}
        self.assertEqual(verdict(after, pod_request), "ACCEPT")
        self.assertEqual(verdict(after, reply), "ACCEPT")
        for packet in ({**reply, "--ctstate": "NEW"}, {**reply, "--ctdir": "ORIGINAL"},
                       {**reply, "--ctorigsrc": "192.0.2.10"},
                       {**reply, "-i": "tailscale0", "--ctstate": "NEW"},
                       {**reply, "-i": "br-existing", "--ctstate": "NEW"},
                       {**pod_request, "-o": "br-existing", "-d": "172.18.0.2"}):
            with self.subTest(packet=packet):
                self.assertEqual(verdict(after, packet), "DROP")
        # The IPv4-only installation leaves every existing IPv6 policy in place.
        v6 = {"-i": "tailscale0", "-o": "owner-hub", "-s": "2001:db8::1", "-d": "2001:db8::2"}
        self.assertEqual(verdict(before, v6, "ip6tables"), "DROP")
        self.assertEqual(verdict(after, v6, "ip6tables"), "DROP")

    def test_saved_rule_serialization_matches_private_rule_readback(self):
        saved = """*filter
:ONESA_K3S_INPUT - [0:0]
-A ONESA_K3S_INPUT -s 10.120.0.0/16 -d 10.12.0.3/32 -i cni0 -p tcp -m tcp --dport 6443 -j ACCEPT
COMMIT
"""
        observed = installer.parse_rules(saved)["filter"]["rules"][0][2:]
        desired = installer.firewall_rules(plan(), ["172.18.0.0/16"])["iptables"][installer.INPUT_CHAIN]
        self.assertIn(observed, desired)

    def test_firewall_application_never_flushes_or_edits_docker_rules(self):
        calls = []
        def fake_run(args, **kwargs):
            calls.append(args)
            return (1, "") if "-C" in args else (0, "")
        with patch.object(installer, "snapshot_firewall", return_value=firewall()), patch.object(installer, "run", side_effect=fake_run):
            installer.apply_private_firewall(plan(), ["172.18.0.0/16"])
        self.assertFalse(any("-F" in call or "-X" in call or "iptables-restore" in call for call in calls))
        self.assertFalse(any("DOCKER-USER" in call and call.index("DOCKER-USER") == call.index("-A") + 1
                             for call in calls if "-A" in call))
        self.assertTrue(any("-I" in call and "INPUT" in call and installer.INPUT_CHAIN in call for call in calls))

    def test_guard_must_precede_kubernetes_forwarding(self):
        state = installed_rules()
        with patch.object(installer, "snapshot_firewall", return_value=state):
            installer.verify_firewall(plan(), ["172.18.0.0/16"], firewall())
        state["iptables"]["filter"]["chains"]["KUBE-FORWARD"] = "-"
        state["iptables"]["filter"]["rules"].insert(0, ["-A", "FORWARD", "-j", "KUBE-FORWARD"])
        with patch.object(installer, "snapshot_firewall", return_value=state), self.assertRaisesRegex(installer.Refused, "ORDER_CHANGED"):
            installer.verify_firewall(plan(), ["172.18.0.0/16"], firewall())

    def test_only_exact_retained_noncluster_owner_permits_may_precede_guard(self):
        permit = ["-A", "FORWARD", "-i", "tailscale0", "-o", "owner-hub", "-s", "100.64.10.2/32",
                  "-d", "10.90.254.2/32", "-p", "tcp", "--dport", "22", "-j", "ACCEPT"]
        before = firewall()
        before["iptables"]["filter"]["rules"].insert(0, permit)
        after = installed_rules(before)
        rows = after["iptables"]["filter"]["rules"]
        rows.remove(permit)
        rows.insert(0, permit)
        with patch.object(installer, "snapshot_firewall", return_value=after):
            installer.verify_firewall(plan(), ["172.18.0.0/16"], before)
        for changed in (
            [value if value != "10.90.254.2/32" else "10.120.0.2/32" for value in permit],
            [value if value != "owner-hub" else "cni0" for value in permit],
            [value if value != "owner-hub" else "owner+" for value in permit],
            permit[:2] + ["-j", "ACCEPT"],
            permit[:2] + ["!"] + permit[2:],
        ):
            self.assertFalse(installer.outside_cluster_permit(changed, plan()))
        # A newly inserted, otherwise narrow permit has no retained authority.
        unexpected = [value if value != "100.64.10.2/32" else "100.64.10.99/32" for value in permit]
        rows.insert(0, unexpected)
        with patch.object(installer, "snapshot_firewall", return_value=after), self.assertRaises(installer.Refused):
            installer.verify_firewall(plan(), ["172.18.0.0/16"], before)


class NetworkPolicyTests(unittest.TestCase):
    def allowed(self, namespace, labels, destination, port, protocol="TCP", destination_namespace=None, destination_labels=None):
        def matches(selector, values):
            return all(values.get(key) == value for key, value in selector.get("matchLabels", {}).items())

        policies = [item["spec"] for item in installer.network_policies(plan())["items"]
                    if item["metadata"]["namespace"] == namespace and matches(item["spec"]["podSelector"], labels)]
        if not policies:
            return True  # Kubernetes additive policy semantics, not a default-deny assumption.
        for policy in policies:
            for rule in policy.get("egress", []):
                if not any(item["port"] == port and item["protocol"] == protocol for item in rule["ports"]):
                    continue
                for peer in rule["to"]:
                    if "ipBlock" in peer:
                        if ipaddress.ip_address(destination) in ipaddress.ip_network(peer["ipBlock"]["cidr"]):
                            return True
                    else:
                        namespace_labels = {"kubernetes.io/metadata.name": destination_namespace}
                        if (matches(peer.get("namespaceSelector", {}), namespace_labels)
                                and matches(peer.get("podSelector", {}), destination_labels or {})):
                            return True
        return False

    def test_only_coredns_in_the_system_namespace_can_use_the_observed_upstream(self):
        identity = {"k8s-app": "kube-dns"}
        for protocol in ("TCP", "UDP"):
            self.assertTrue(self.allowed("kube-system", identity, "169.254.169.254", 53, protocol))
            for namespace, labels in (("portainer", installer.portainer.LABELS), ("default", identity),
                                      ("portainer", identity), ("kube-system", {"k8s-app": "metrics-server"})):
                with self.subTest(namespace=namespace, labels=labels, protocol=protocol):
                    self.assertFalse(self.allowed(namespace, labels, "169.254.169.254", 53, protocol))
        self.assertFalse(self.allowed("kube-system", identity, "169.254.169.254", 80))
        self.assertFalse(self.allowed("kube-system", identity, "192.0.2.53", 53, "UDP"))

    def test_portainer_uses_cluster_dns_and_the_api_without_inheriting_node_or_upstream_access(self):
        self.assertTrue(self.allowed("portainer", installer.portainer.LABELS, "10.120.0.3", 53, "UDP",
                                     "kube-system", {"k8s-app": "kube-dns"}))
        for namespace, labels in (("default", {"k8s-app": "kube-dns"}), ("kube-system", {"app": "unrelated"})):
            self.assertFalse(self.allowed("portainer", installer.portainer.LABELS, "10.120.0.3", 53, "UDP", namespace, labels))
        for namespace, labels in (("portainer", installer.portainer.LABELS), ("kube-system", {"k8s-app": "kube-dns"}),
                                  ("kube-system", {"k8s-app": "metrics-server"})):
            self.assertTrue(self.allowed(namespace, labels, plan()["private_ip"], 6443))
            self.assertTrue(self.allowed(namespace, labels, "10.121.0.1", 443))
        self.assertFalse(self.allowed("portainer", installer.portainer.LABELS, plan()["private_ip"], 10250))
        self.assertTrue(self.allowed("kube-system", {"k8s-app": "metrics-server"}, plan()["private_ip"], 10250))

    def observation(self):
        expected = installer.network_policies(plan())["items"]
        expected += [item for item in installer.manifests(installer.releases(), "onesa-test")[0]["items"] if item["kind"] == "NetworkPolicy"]
        mapping = {("namespaces", None): {"items": [{"metadata": {"name": name}} for name in sorted({item["metadata"]["namespace"] for item in expected})]},
                   ("deployment/coredns", "kube-system"): {"spec": {"template": {"metadata": {"labels": {"k8s-app": "kube-dns"}},
                                                                             "spec": {"serviceAccountName": "coredns"}}},
                                                            "status": {"availableReplicas": 1}}}
        for item in expected:
            value = copy.deepcopy(item)
            for direction in ("ingress", "egress"):
                if value["spec"].get(direction) == []:
                    del value["spec"][direction]
            mapping.setdefault(("networkpolicies", value["metadata"]["namespace"]), {"items": []})["items"].append(value)
        return mapping

    def test_readback_normalizes_empty_arrays_and_rejects_additive_policy_widening(self):
        mapping = self.observation()
        with patch.object(installer, "get_resource", side_effect=lambda resource, namespace=None: mapping[resource, namespace]):
            installer.verify_network_policies(plan())
            mapping["networkpolicies", "portainer"]["items"].append({"metadata": {"name": "unexpected-allow"}, "spec": {"egress": [{}]}})
            with self.assertRaisesRegex(installer.Refused, "UNREVIEWED_NETWORK_POLICY"):
                installer.verify_network_policies(plan())
        mapping = self.observation()
        mapping["networkpolicies", "kube-system"]["items"][0]["spec"]["egress"] = [{}]
        with patch.object(installer, "get_resource", side_effect=lambda resource, namespace=None: mapping[resource, namespace]), self.assertRaises(installer.Refused):
            installer.verify_network_policies(plan())

    def test_pod_api_endpoints_must_use_the_private_node_address(self):
        service = {"spec": {"type": "ClusterIP", "clusterIP": "10.121.0.1",
                            "ports": [{"name": "https", "port": 443, "protocol": "TCP", "targetPort": 6443}]}}
        endpoint = {"metadata": {"labels": {"kubernetes.io/service-name": "kubernetes"}}, "addressType": "IPv4",
                    "ports": [{"name": "https", "port": 6443, "protocol": "TCP"}],
                    "endpoints": [{"conditions": {"ready": True}, "addresses": [plan()["private_ip"]]}]}
        def observe(resource, namespace):
            return service if resource == "service/kubernetes" else {"items": [endpoint]}
        with patch.object(installer, "get_resource", side_effect=observe):
            installer.verify_api_service(plan())
            for address in ("127.0.0.1", "192.0.2.10"):
                endpoint["endpoints"][0]["addresses"] = [address]
                with self.subTest(address=address), self.assertRaisesRegex(installer.Refused, "API_ENDPOINT"):
                    installer.verify_api_service(plan())


class FileAndLifecycleTests(unittest.TestCase):
    def setUp(self):
        # Production correctly rejects writable ancestors such as /tmp (1777).
        # Keep synthetic custody files beneath the test user's private home.
        self.temporary = tempfile.TemporaryDirectory(prefix="onesa-k3s-test-", dir=Path.home())
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        paths = {"STATE": self.root / "state", "RECEIPT": self.root / "state/installation.json",
                 "CONFIG_DIR": self.root / "config", "CONFIG": self.root / "config/config.yaml",
                 "KUBECONFIG": self.root / "config/k3s.yaml", "DATA": self.root / "data",
                 "LIB": self.root / "lib", "BINARY": self.root / "bin/k3s", "UNIT_DIR": self.root / "units",
                 "LOCK": self.root / "install.lock"}
        for key, value in paths.items():
            active = patch.object(installer, key, value)
            active.start()
            self.addCleanup(active.stop)
        active = patch.object(installer, "ROOT_UID", os.getuid())
        active.start()
        self.addCleanup(active.stop)
        installer.UNIT_DIR.mkdir()
        installer.BINARY.parent.mkdir()
        artifact_dir = self.root / "artifacts"
        artifact_dir.mkdir()
        self.lock = copy.deepcopy(installer.releases())
        source = {}
        for kind, name in (("binary", "k3s-arm64"), ("airgap", "k3s-airgap-images-arm64.tar.zst")):
            value = ("synthetic release " + kind).encode()
            path = artifact_dir / name
            path.write_bytes(value)
            source[kind] = path
            self.lock["k3s"]["platforms"]["arm64"][kind] = {"name": name, "size": len(value), "sha256": installer.digest(value)}
        self.facts = {"node": "onesa-test", "interface": "ens3", "observation": {"architecture": "aarch64"},
                      "firewall": firewall(), "native": {}, "policy_routes": {"-4": [], "-6": []}, "docker_subnets": ["172.18.0.0/16"], "sources": source}
        self.commands = []

    def shared_lifecycle(self):
        module = installer.lifecycle_module(self.lock)
        module.OWNER_UID = os.getuid()
        module.STATE = self.root / "shared-lifecycle"
        module.STATE.mkdir(mode=0o700)
        module.LOCK = module.STATE / "lifecycle.lock"
        module.HOLD = module.STATE / "maintenance.json"
        module.CONFIG = self.root / "absent-recovery-config.json"
        return module

    @contextlib.contextmanager
    def mocked_host(self, failure=None):
        def fake_command(args, **kwargs):
            self.commands.append(args)
            if failure and failure(args):
                raise installer.Refused("SYNTHETIC_STAGE_FAILURE")
            if args[:2] == ["systemctl", "show"]:
                return "LoadState=loaded\nFragmentPath=" + str(installer.UNIT_DIR / args[2]) + "\nDropInPaths=\nTransient=no\n"
            return ""
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(installer, "command", side_effect=fake_command))
            stack.enter_context(patch.object(installer, "run", side_effect=lambda args, **kwargs: (self.commands.append(args) or (0, ""))))
            stack.enter_context(patch.object(installer.preflight, "docker_snapshot", return_value={"count": 2, "fingerprint": "synthetic"}))
            for function in ("apply_private_firewall", "ensure_native_guard", "verify_firewall", "verify_node", "verify_portainer"):
                stack.enter_context(patch.object(installer, function))
            stack.enter_context(patch.object(installer, "verify_installation", return_value={"status": "SYNTHETIC_PASS"}))
            yield

    def test_artifact_hash_and_symlink_are_rejected(self):
        directory = self.facts["sources"]["binary"].parent
        installer.artifacts(directory, "aarch64", self.lock)
        self.facts["sources"]["binary"].write_bytes(b"x" * self.lock["k3s"]["platforms"]["arm64"]["binary"]["size"])
        with self.assertRaisesRegex(installer.Refused, "HASH_MISMATCH"):
            installer.artifacts(directory, "aarch64", self.lock)
        self.facts["sources"]["binary"].unlink()
        self.facts["sources"]["binary"].symlink_to(self.facts["sources"]["airgap"])
        with self.assertRaisesRegex(installer.Refused, "FILE_INVALID"):
            installer.artifacts(directory, "aarch64", self.lock)

    def test_native_guard_creation_pins_readback_and_never_overwrites_existing_table(self):
        installer.STATE.mkdir(mode=0o700)
        path = installer.STATE / "private-firewall.nft"
        path.write_bytes(installer.native_guard_source(plan(), ["172.18.0.0/16"]))
        path.chmod(0o600)
        native = {"retained_guard": "a" * 64}
        receipt = {"native_before": native, "docker_subnets": ["172.18.0.0/16"]}
        with patch.object(installer, "snapshot_native_guards", return_value=native), \
                patch.object(installer, "native_tables", return_value=[]), \
                patch.object(installer, "native_digest", return_value="b" * 64), \
                patch.object(installer, "save_receipt") as save, patch.object(installer, "command") as command:
            installer.ensure_native_guard(plan(), receipt, first_install=True)
        self.assertEqual(receipt["native_guard_sha256"], "b" * 64)
        command.assert_called_once_with(["nft", "--file", str(path)])
        save.assert_called_once_with(receipt)
        with patch.object(installer, "snapshot_native_guards", return_value=native), \
                patch.object(installer, "native_tables", return_value=[installer.NATIVE_TABLE]), \
                patch.object(installer, "native_digest", return_value="c" * 64), \
                patch.object(installer, "command") as command, \
                self.assertRaisesRegex(installer.Refused, "PRIVATE_NATIVE_FIREWALL_DRIFT"):
            installer.ensure_native_guard(plan(), receipt)
        command.assert_not_called()
        with patch.object(installer, "snapshot_native_guards", return_value={"retained_guard": "c" * 64}), \
                patch.object(installer, "command") as command, \
                self.assertRaisesRegex(installer.Refused, "EXISTING_NATIVE_FIREWALL_CHANGED"):
            installer.ensure_native_guard(plan(), receipt)
        command.assert_not_called()

    def test_artifact_replacement_after_open_cannot_supply_unverified_copy(self):
        original = self.facts["sources"]["binary"]
        replacement = original.with_suffix(".replacement")
        replacement.write_bytes(b"X" * original.stat().st_size)
        original_fdopen = os.fdopen
        def replace_before_read(fd, mode, *args, **kwargs):
            if mode == "rb" and replacement.exists():
                replacement.replace(original)
            return original_fdopen(fd, mode, *args, **kwargs)
        with patch.object(installer.os, "fdopen", side_effect=replace_before_read), \
                self.assertRaisesRegex(installer.Refused, "ARTIFACT_REPLACED_DURING_READ"):
            installer.verified_artifact_bytes(original, self.lock["k3s"]["platforms"]["arm64"]["binary"])

    def test_writable_artifact_parent_is_refused(self):
        original = self.facts["sources"]["binary"]
        original.parent.chmod(0o777)
        with self.assertRaisesRegex(installer.Refused, "UNSAFE_PARENT_CUSTODY"):
            installer.verified_artifact_bytes(original, self.lock["k3s"]["platforms"]["arm64"]["binary"])

    def test_private_plan_refuses_other_users_and_symlinks(self):
        path = self.root / "private.json"
        path.write_bytes(installer.encoded(plan()))
        path.chmod(0o600)
        installer.private_file(path)
        path.chmod(0o644)
        with self.assertRaisesRegex(installer.Refused, "PRIVATE_ROOT_OWNED"):
            installer.private_file(path)
        alias = self.root / "alias"
        alias.symlink_to(path)
        with self.assertRaisesRegex(installer.Refused, "PRIVATE_ROOT_OWNED"):
            installer.private_file(alias)

    def test_first_install_journals_and_retains_dedicated_data(self):
        with self.mocked_host():
            result = installer.install(plan(), self.facts, self.lock, "synthetic-maintenance-token")
        self.assertEqual(result["status"], "SYNTHETIC_PASS")
        receipt = installer.load_receipt(plan())
        self.assertEqual(receipt["phase"], "READY_OWNER_QUALIFICATION_REQUIRED")
        installer.verify_owned_files(receipt)
        self.assertEqual(stat.S_IMODE(installer.RECEIPT.stat().st_mode), 0o600)
        self.assertTrue((installer.STATE / "portainer").is_dir())
        start = [call for call in self.commands if call[:2] == ["systemctl", "start"]]
        self.assertEqual(start, [["systemctl", "start", installer.UNIT]])
        self.assertFalse(any("docker" in call or "restart" in call for call in self.commands))

    def test_start_failure_holds_only_owned_unit_and_preserves_files(self):
        with self.mocked_host(failure=lambda args: args[:2] == ["systemctl", "start"]):
            result = installer.install(plan(), self.facts, self.lock, "synthetic-maintenance-token")
        self.assertEqual(result["status"], "HELD_REVIEW_REQUIRED")
        self.assertTrue(result["runtime_cleanup_requires_review"])
        self.assertEqual(installer.load_receipt(plan())["phase"], "HELD_REVIEW_REQUIRED")
        self.assertTrue(installer.BINARY.exists())
        self.assertTrue((installer.STATE / "portainer").exists())
        self.assertIn(["systemctl", "disable", "--now", installer.UNIT], self.commands)
        self.assertFalse(any("killall" in " ".join(call) or "uninstall" in " ".join(call) for call in self.commands))

    def test_hold_never_stops_unit_whose_contents_changed(self):
        with self.mocked_host():
            installer.install(plan(), self.facts, self.lock, "synthetic-maintenance-token")
            receipt = installer.load_receipt(plan())
            (installer.UNIT_DIR / installer.UNIT).write_text("unrelated unit\n")
            self.commands.clear()
            installer.hold_installation(receipt, "SYNTHETIC_DRIFT")
        self.assertEqual(self.commands, [])

    def test_stale_temporary_receipt_does_not_prevent_durable_hold(self):
        with self.mocked_host():
            installer.install(plan(), self.facts, self.lock, "synthetic-maintenance-token")
            stale = installer.RECEIPT.with_suffix(".new")
            stale.write_bytes(b"retained interrupted evidence")
            result = installer.hold_installation(installer.load_receipt(plan()), "SYNTHETIC_INTERRUPT")
        self.assertTrue(result["hold_persisted"])
        self.assertTrue(result["owned_unit_stop_attempted"])
        self.assertEqual(stale.read_bytes(), b"retained interrupted evidence")

    def test_hold_stops_proven_unit_even_when_receipt_storage_fails(self):
        with self.mocked_host():
            installer.install(plan(), self.facts, self.lock, "synthetic-maintenance-token")
            receipt = installer.load_receipt(plan())
            self.commands.clear()
            with patch.object(installer, "save_receipt", side_effect=OSError("synthetic storage failure")):
                result = installer.hold_installation(receipt, "SYNTHETIC_INTERRUPT")
        self.assertEqual(result["status"], "HOLD_PERSISTENCE_FAILED")
        self.assertFalse(result["hold_persisted"])
        self.assertTrue(result["owned_unit_stop_attempted"])
        self.assertIn(["systemctl", "disable", "--now", installer.UNIT], self.commands)

    def test_hold_refuses_effective_systemd_override(self):
        with self.mocked_host():
            installer.install(plan(), self.facts, self.lock, "synthetic-maintenance-token")
            receipt = installer.load_receipt(plan())
            self.commands.clear()
            with patch.object(installer, "unit_metadata", return_value={"LoadState": "loaded", "Transient": "no",
                              "FragmentPath": str(installer.UNIT_DIR / installer.UNIT), "DropInPaths": "/etc/systemd/system/service.d/extra.conf"}):
                result = installer.hold_installation(receipt, "SYNTHETIC_OVERRIDE")
        self.assertFalse(result["owned_unit_stop_attempted"])
        self.assertNotIn(["systemctl", "disable", "--now", installer.UNIT], self.commands)

    def test_successful_reinvocation_is_verification_only(self):
        with self.mocked_host():
            installer.install(plan(), self.facts, self.lock, "synthetic-maintenance-token")
        private_plan = installer.STATE / "plan.json"
        args = ["installer", "install", "--plan", str(private_plan)]
        lifecycle = self.shared_lifecycle()
        with patch.object(sys, "argv", args), patch.object(installer, "current_identity"), \
                patch.object(installer, "releases", return_value=self.lock), \
                patch.object(installer, "lifecycle_module", return_value=lifecycle), \
                patch.object(installer, "verify_installation", return_value={"status": "VERIFIED_PASS"}) as verify, \
                patch.object(installer, "collect_first_install") as collect, \
                patch.object(installer, "install") as install, contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(installer.main(), 0)
        self.assertTrue(json.loads(output.getvalue())["already_installed"])
        verify.assert_called_once()
        collect.assert_not_called()
        install.assert_not_called()

    def test_interrupted_receipt_cannot_restart(self):
        with self.mocked_host(failure=lambda args: args[:2] == ["systemctl", "start"]):
            installer.install(plan(), self.facts, self.lock, "synthetic-maintenance-token")
        args = ["installer", "install", "--plan", str(installer.STATE / "plan.json")]
        with patch.object(sys, "argv", args), patch.object(installer, "current_identity"), \
                patch.object(installer, "releases", return_value=self.lock), \
                patch.object(installer, "install") as install, contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(installer.main(), 2)
        self.assertEqual(json.loads(output.getvalue())["reason"], "INTERRUPTED_INSTALLATION_REQUIRES_REVIEW")
        install.assert_not_called()

    def test_existing_shared_maintenance_blocks_install_before_any_host_mutation(self):
        lifecycle = self.shared_lifecycle()
        with lifecycle.lifecycle_lock() as guard:
            guard.begin_hold("owner-deploy", "synthetic-application", "synthetic-existing-operation")
        private_plan = self.root / "private-plan.json"
        installer.write_new(private_plan, installer.encoded(plan()))
        args = ["installer", "install", "--plan", str(private_plan), "--artifacts", str(self.facts["sources"]["binary"].parent)]
        with patch.object(sys, "argv", args), patch.object(installer, "current_identity"), \
                patch.object(installer, "releases", return_value=self.lock), \
                patch.object(installer, "lifecycle_module", return_value=lifecycle), \
                patch.object(installer, "collect_first_install", return_value=self.facts), \
                patch.object(installer, "install") as install, contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(installer.main(), 2)
        self.assertEqual(json.loads(output.getvalue())["reason"], "SHARED_HOST_MAINTENANCE_IN_PROGRESS")
        install.assert_not_called()
        self.assertFalse(installer.STATE.exists())

    def test_install_uses_real_shared_hold_then_releases_only_on_success(self):
        lifecycle = self.shared_lifecycle()
        private_plan = self.root / "private-plan.json"
        installer.write_new(private_plan, installer.encoded(plan()))
        args = ["installer", "install", "--plan", str(private_plan), "--artifacts", str(self.facts["sources"]["binary"].parent)]
        def check_hold(actual_plan, facts, lock, token):
            hold = lifecycle.read_private_json(lifecycle.HOLD)
            self.assertEqual(hold["token"], token)
            self.assertEqual(hold["kind"], installer.LEASE_KIND)
            self.assertEqual(hold["reference"], installer.digest(installer.encoded(actual_plan)))
            self.assertTrue(installer.LOCK.exists())
            return {"status": "SYNTHETIC_PASS"}
        with patch.object(sys, "argv", args), patch.object(installer, "current_identity"), \
                patch.object(installer, "releases", return_value=self.lock), \
                patch.object(installer, "lifecycle_module", return_value=lifecycle), \
                patch.object(installer, "collect_first_install", return_value=self.facts), \
                patch.object(installer, "install", side_effect=check_hold), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(installer.main(), 0)
        self.assertFalse(lifecycle.HOLD.exists())

    def test_failed_install_keeps_real_shared_maintenance_hold(self):
        lifecycle = self.shared_lifecycle()
        private_plan = self.root / "private-plan.json"
        installer.write_new(private_plan, installer.encoded(plan()))
        args = ["installer", "install", "--plan", str(private_plan), "--artifacts", str(self.facts["sources"]["binary"].parent)]
        with patch.object(sys, "argv", args), patch.object(installer, "current_identity"), \
                patch.object(installer, "releases", return_value=self.lock), \
                patch.object(installer, "lifecycle_module", return_value=lifecycle), \
                patch.object(installer, "collect_first_install", return_value=self.facts), \
                patch.object(installer, "install", return_value={"status": "HELD_REVIEW_REQUIRED"}), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(installer.main(), 2)
        self.assertEqual(lifecycle.read_private_json(lifecycle.HOLD)["kind"], installer.LEASE_KIND)

    def test_matching_revoked_service_hold_cannot_launch_or_change_firewall(self):
        lifecycle = self.shared_lifecycle()
        with lifecycle.lifecycle_lock() as guard:
            token = guard.begin_hold(installer.LEASE_KIND, installer.LEASE_SCOPE, installer.digest(installer.encoded(plan())))
            guard.mark_revocation("synthetic-application", "synthetic-owner-revocation")
        with self.mocked_host():
            installer.install(plan(), self.facts, self.lock, token)
        private_plan = installer.STATE / "plan.json"
        for action in ("serve", "firewall"):
            args = ["installer", action, "--plan", str(private_plan)]
            with patch.object(sys, "argv", args), patch.object(installer, "current_identity"), \
                    patch.object(installer, "releases", return_value=self.lock), \
                    patch.object(installer, "lifecycle_module", return_value=lifecycle), \
                    patch.object(installer, "clean_server_exec") as execute, \
                    patch.object(installer, "apply_private_firewall") as firewall_apply, \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(installer.main(), 2)
            self.assertEqual(json.loads(output.getvalue())["reason"], "SHARED_HOST_REVOCATION_REQUIRES_REVIEW")
            execute.assert_not_called()
            firewall_apply.assert_not_called()

    def test_matching_fields_do_not_bypass_existing_hold_schema_validation(self):
        lifecycle = self.shared_lifecycle()
        with lifecycle.lifecycle_lock() as guard:
            token = guard.begin_hold(installer.LEASE_KIND, installer.LEASE_SCOPE, installer.digest(installer.encoded(plan())))
        receipt = {"phase": "STARTING", "maintenance_token": token}
        hold = lifecycle.read_private_json(lifecycle.HOLD)
        del hold["created_at"]
        lifecycle.write_private_json(lifecycle.HOLD, hold)
        with patch.object(installer, "lifecycle_module", return_value=lifecycle), \
                self.assertRaisesRegex(installer.Refused, "LIFECYCLE_HOLD_INVALID"):
            installer.check_service_lease(plan(), receipt, self.lock)

    def test_stale_matching_service_hold_cannot_launch_or_change_firewall(self):
        lifecycle = self.shared_lifecycle()
        with lifecycle.lifecycle_lock() as guard:
            token = guard.begin_hold(installer.LEASE_KIND, installer.LEASE_SCOPE, installer.digest(installer.encoded(plan())))
        with self.mocked_host():
            installer.install(plan(), self.facts, self.lock, token)
        receipt = installer.load_receipt(plan())
        for phase in ("FILES_PREPARED", "STARTING", "APPLYING_PORTAINER"):
            receipt["phase"] = phase
            installer.save_receipt(receipt)
            for action in ("serve", "firewall"):
                args = ["installer", action, "--plan", str(installer.STATE / "plan.json")]
                with self.subTest(phase=phase, action=action), patch.object(sys, "argv", args), \
                        patch.object(installer, "current_identity"), patch.object(installer, "releases", return_value=self.lock), \
                        patch.object(installer, "lifecycle_module", return_value=lifecycle), \
                        patch.object(installer, "effective_owned_unit"), \
                        patch.object(installer, "clean_server_exec") as execute, \
                        patch.object(installer, "apply_private_firewall") as firewall_apply, \
                        patch.object(installer, "verify_firewall"), \
                        contextlib.redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(installer.main(), 2)
                    self.assertEqual(json.loads(output.getvalue())["reason"], "INSTALLATION_GLOBAL_LOCK_INACTIVE")
                execute.assert_not_called()
                firewall_apply.assert_not_called()

    def test_service_child_requires_both_active_installer_locks(self):
        lifecycle = self.shared_lifecycle()
        installer.write_new(installer.LOCK, b"")
        with lifecycle.lifecycle_lock() as guard:
            token = guard.begin_hold(installer.LEASE_KIND, installer.LEASE_SCOPE, installer.digest(installer.encoded(plan())))
            receipt = {"phase": "STARTING", "maintenance_token": token}
            with patch.object(installer, "lifecycle_module", return_value=lifecycle):
                with self.assertRaisesRegex(installer.Refused, "INSTALLATION_COMPONENT_LOCK_INACTIVE"):
                    installer.check_service_lease(plan(), receipt, self.lock)
                with installer.LOCK.open("rb") as component:
                    installer.fcntl.flock(component, installer.fcntl.LOCK_EX | installer.fcntl.LOCK_NB)
                    for phase in ("FILES_PREPARED", "STARTING", "APPLYING_PORTAINER"):
                        installer.check_service_lease(plan(), {**receipt, "phase": phase}, self.lock)
                with self.assertRaisesRegex(installer.Refused, "INSTALLATION_COMPONENT_LOCK_INACTIVE"):
                    installer.check_service_lease(plan(), receipt, self.lock)
        with patch.object(installer, "lifecycle_module", return_value=lifecycle), \
                self.assertRaisesRegex(installer.Refused, "INSTALLATION_GLOBAL_LOCK_INACTIVE"):
            installer.check_service_lease(plan(), receipt, self.lock)

    def test_ready_service_restart_requires_completed_hold(self):
        lifecycle = self.shared_lifecycle()
        installer.write_new(installer.LOCK, b"")
        with lifecycle.lifecycle_lock() as guard:
            token = guard.begin_hold(installer.LEASE_KIND, installer.LEASE_SCOPE, installer.digest(installer.encoded(plan())))
            receipt = {"phase": "READY_OWNER_QUALIFICATION_REQUIRED", "maintenance_token": token}
            with installer.LOCK.open("rb") as component:
                installer.fcntl.flock(component, installer.fcntl.LOCK_EX | installer.fcntl.LOCK_NB)
                with patch.object(installer, "lifecycle_module", return_value=lifecycle), \
                        self.assertRaisesRegex(installer.Refused, "SHARED_HOST_MAINTENANCE_RECONCILIATION_REQUIRED"):
                    installer.check_service_lease(plan(), receipt, self.lock)
            guard.complete_hold(token)
        with patch.object(installer, "lifecycle_module", return_value=lifecycle):
            installer.check_service_lease(plan(), receipt, self.lock)
            with lifecycle.LOCK.open("rb") as probe:
                installer.fcntl.flock(probe, installer.fcntl.LOCK_EX | installer.fcntl.LOCK_NB)

    def test_service_child_rejects_component_lock_custody_drift(self):
        lifecycle = self.shared_lifecycle()
        installer.write_new(installer.LOCK, b"")
        with lifecycle.lifecycle_lock() as guard, installer.LOCK.open("rb") as component:
            token = guard.begin_hold(installer.LEASE_KIND, installer.LEASE_SCOPE, installer.digest(installer.encoded(plan())))
            receipt = {"phase": "STARTING", "maintenance_token": token}
            installer.fcntl.flock(component, installer.fcntl.LOCK_EX | installer.fcntl.LOCK_NB)
            installer.LOCK.chmod(0o644)
            with patch.object(installer, "lifecycle_module", return_value=lifecycle), \
                    self.assertRaisesRegex(installer.Refused, "LIFECYCLE_PRIVATE_CUSTODY"):
                installer.check_service_lease(plan(), receipt, self.lock)

    def test_service_child_rejects_component_lock_replacement_during_probe(self):
        lifecycle = self.shared_lifecycle()
        installer.write_new(installer.LOCK, b"")
        real_probe = installer.require_contended_lock
        def replace_after_probe(fd, code):
            real_probe(fd, code)
            if code == "INSTALLATION_COMPONENT_LOCK_INACTIVE":
                replacement = self.root / "replacement.lock"
                installer.write_new(replacement, b"")
                replacement.replace(installer.LOCK)
        with lifecycle.lifecycle_lock() as guard, installer.LOCK.open("rb") as component:
            token = guard.begin_hold(installer.LEASE_KIND, installer.LEASE_SCOPE, installer.digest(installer.encoded(plan())))
            receipt = {"phase": "STARTING", "maintenance_token": token}
            installer.fcntl.flock(component, installer.fcntl.LOCK_EX | installer.fcntl.LOCK_NB)
            with patch.object(installer, "lifecycle_module", return_value=lifecycle), \
                    patch.object(installer, "require_contended_lock", side_effect=replace_after_probe), \
                    self.assertRaisesRegex(installer.Refused, "LIFECYCLE_FILE_REPLACED"):
                installer.check_service_lease(plan(), receipt, self.lock)

    def test_ready_receipt_is_durable_before_units_are_enabled(self):
        observed = []
        def observe_enable(arguments):
            if arguments[:2] == ["systemctl", "enable"]:
                observed.append(installer.load_receipt(plan())["phase"])
            return False
        with self.mocked_host(failure=observe_enable):
            result = installer.install(plan(), self.facts, self.lock, "synthetic-maintenance-token")
        self.assertEqual(result["status"], "SYNTHETIC_PASS")
        self.assertEqual(observed, ["READY_OWNER_QUALIFICATION_REQUIRED"])

    def test_failed_ready_receipt_never_enables_units(self):
        real_save = installer.save_receipt
        def fail_ready(receipt):
            if receipt["phase"] == "READY_OWNER_QUALIFICATION_REQUIRED":
                raise OSError("synthetic ready receipt failure")
            real_save(receipt)
        with self.mocked_host(), patch.object(installer, "save_receipt", side_effect=fail_ready):
            result = installer.install(plan(), self.facts, self.lock, "synthetic-maintenance-token")
        self.assertEqual(result["status"], "HELD_REVIEW_REQUIRED")
        self.assertFalse(any(call[:2] == ["systemctl", "enable"] for call in self.commands))
        self.assertIn(["systemctl", "disable", "--now", installer.UNIT], self.commands)


if __name__ == "__main__":
    unittest.main()
