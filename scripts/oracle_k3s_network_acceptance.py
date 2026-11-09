#!/usr/bin/env python3
"""Synthetic packet qualification in new net/mount/PID namespaces only.

The parent reads and fingerprints host networking, then delegates every network
mutation to an isolated child. No Docker, systemd, provider or live application
command is used. No host interface, route, table, service or namespace is changed.
Run only from reviewed root-owned source; this is not an installer.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import socket
import stat
import subprocess
import sys
import time


SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ROOT = Path(__file__).resolve().parents[1]
ALLOWED = {"ip", "iptables", "ip6tables", "iptables-save", "ip6tables-save",
           "iptables-restore", "ip6tables-restore", "nft", "mount", "sysctl"}
ENV = {"PATH": SAFE_PATH, "LANG": "C", "LC_ALL": "C"}
NODE = "10.12.0.3"
OWNER = "100.64.10.2"
PEERS = ("10.90.254.2", "10.90.254.3")
SITE = ("10.91.254.2", "10.91.254.3")
POD = "10.120.0.2"
DNS_POD = "10.120.0.3"
UPSTREAM = "169.254.169.254"
DOCKER = "172.18.0.2"
WAN = "192.0.2.2"
PODS = "10.120.0.0/16"
SERVICES = "10.121.0.0/16"


class Failed(Exception):
    pass


def require(value, code):
    if not value:
        raise Failed(code)


def run(args, data=None, timeout=10):
    require(args[0] in ALLOWED, "UNREVIEWED_COMMAND")
    binary = shutil.which(args[0], path=SAFE_PATH)
    require(binary, "MISSING_TEST_COMMAND")
    result = subprocess.run([binary, *args[1:]], input=data, capture_output=True,
                            timeout=timeout, env=ENV, check=False)
    require(result.returncode == 0, "ISOLATED_COMMAND_FAILED:" + args[0])
    require(len(result.stdout) <= 4 * 1024 * 1024, "OVERSIZED_TEST_OUTPUT")
    return result.stdout.decode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fingerprints():
    result = {}
    for family in ("iptables", "ip6tables"):
        raw = run([family + "-save"])
        stable = "\n".join(re.sub(r"\[\d+:\d+\]", "[0:0]", line)
                           for line in raw.splitlines() if line and not line.startswith("#"))
        result[family] = digest(stable.encode())
    for name in ("link", "address"):
        result[name] = digest(run(["ip", "-json", name, "show"]).encode())
    for family in ("-4", "-6"):
        for name in ("route", "rule"):
            arguments = ["ip", "-json", family, name, "show"]
            if name == "route":
                arguments += ["table", "all"]
            result[family + "/" + name] = digest(run(arguments).encode())
    rows = json.loads(run(["nft", "--json", "list", "tables"]))["nftables"]
    for row in rows:
        table = row.get("table", {})
        if table.get("family") == "inet":
            name = table.get("name", "")
            require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", name), "UNSAFE_NATIVE_TABLE_NAME")
            result["inet/" + name] = digest(run(["nft", "--numeric", "list", "table", "inet", name]).encode())
    return result


def source_pins():
    paths = [Path(__file__), *[ROOT / "infra/oracle" / name for name in (
        "k3s_first_install.py", "kubernetes_preflight.py", "portainer_private.py", "k3s_release_lock.json")]]
    for path in paths:
        require(not path.is_symlink(), "SOURCE_SYMLINK_REFUSED")
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                "ROOT_OWNED_REVIEWED_SOURCE_REQUIRED")
        for parent in path.parents:
            info = parent.lstat()
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                    "ROOT_OWNED_SOURCE_CUSTODY_REQUIRED")
    return {path.name: digest(path.read_bytes()) for path in paths}


def bridge_prerequisites():
    # Called only after source custody checks; importing the reviewed installer
    # performs no operations. Share its read-only prerequisite and exact refusal.
    sys.path.insert(0, str(ROOT / "infra/oracle"))
    import k3s_first_install as installer
    try:
        return installer.require_bridge_netfilter()
    except installer.Refused as error:
        raise Failed(str(error)) from None


def plan():
    return {"private_ip": NODE, "pod_cidr": PODS, "service_cidr": SERVICES,
            "dns_upstream_ipv4": [UPSTREAM],
            "reserved_cidrs": ["10.12.0.0/16", "10.90.254.0/24", "10.91.254.0/24", "100.64.0.0/10"]}


SERVER = r'''
import json,selectors,socket,sys
settings=json.loads(sys.argv[1]); selector=selectors.DefaultSelector()
addresses=[(socket.AF_INET,a) for a in settings['bind4']]+[(socket.AF_INET6,a) for a in settings['bind6']]
for protocol in ('tcp','udp'):
 for port in settings[protocol]:
  for family,address in addresses:
   s=socket.socket(family,socket.SOCK_STREAM if protocol=='tcp' else socket.SOCK_DGRAM)
   s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
   if family==socket.AF_INET6:s.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1)
   s.bind((address,port));s.setblocking(False)
   if protocol=='tcp':s.listen(16)
   selector.register(s,selectors.EVENT_READ,protocol)
print('READY',flush=True)
while True:
 for key,event in selector.select():
  if key.data=='tcp':
   c,a=key.fileobj.accept();c.sendall(b'qualified');c.close()
  else:
   b,a=key.fileobj.recvfrom(64);key.fileobj.sendto(b'qualified',a)
'''

CLIENT = r'''
import json,socket,sys
p=json.loads(sys.argv[1]);family=socket.AF_INET6 if ':' in p['target'] else socket.AF_INET
s=socket.socket(family,socket.SOCK_STREAM if p['protocol']=='tcp' else socket.SOCK_DGRAM)
s.settimeout(0.8)
try:
 if p.get('mark') is not None:s.setsockopt(socket.SOL_SOCKET,socket.SO_MARK,p['mark'])
 if p.get('source'):s.bind((p['source'],0))
 s.connect((p['target'],p['port']))
 if p['protocol']=='udp':s.send(b'probe')
 print('PASS' if s.recv(32)==b'qualified' else 'FAIL')
except OSError:print('BLOCKED')
finally:s.close()
'''


def start_server(namespace, tcp, udp, bind4=("0.0.0.0",), bind6=("::",)):
    args = ([shutil.which("ip", path=SAFE_PATH), "netns", "exec", namespace] if namespace else [])
    args += [sys.executable, "-I", "-B", "-S", "-c", SERVER,
             json.dumps({"tcp": tcp, "udp": udp, "bind4": bind4, "bind6": bind6})]
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=ENV)
    # A failed child cannot be mistaken for a firewall rejection.
    require(readline(process) == b"READY", "FIXTURE_SERVER_NOT_READY")
    return process


def readline(process, timeout=3):
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        require(selector.select(timeout), "FIXTURE_PROCESS_TIMEOUT")
        return process.stdout.readline().strip()


def probe(namespace, target, port, *, source=None, protocol="tcp", mark=None):
    require(namespace is None or mark is None, "REMOTE_NAMESPACE_MARK_IS_NOT_HOST_MARK")
    args = ([shutil.which("ip", path=SAFE_PATH), "netns", "exec", namespace] if namespace else [])
    args += [sys.executable, "-I", "-B", "-S", "-c", CLIENT,
             json.dumps({"target": target, "port": port, "source": source, "protocol": protocol, "mark": mark})]
    result = subprocess.run(args, capture_output=True, env=ENV, timeout=3, check=False)
    require(result.returncode == 0 and result.stdout.strip() in {b"PASS", b"BLOCKED"}, "FIXTURE_CLIENT_FAILED")
    return result.stdout.strip() == b"PASS"


def network(namespace, interface, subnet, address, v6_index, aliases=(), bridge=None, v6_host=2):
    run(["ip", "netns", "add", namespace])
    run(["ip", "link", "add", interface, "type", "veth", "peer", "name", "peer-" + namespace])
    run(["ip", "link", "set", "peer-" + namespace, "netns", namespace])
    if bridge:
        run(["ip", "link", "set", interface, "master", bridge])
    else:
        run(["ip", "addr", "add", subnet, "dev", interface])
        run(["ip", "-6", "addr", "add", f"2001:db8:{v6_index}::1/64", "dev", interface, "nodad"])
    run(["ip", "link", "set", interface, "up"])
    base = ["ip", "netns", "exec", namespace, "ip"]
    run([*base, "link", "set", "lo", "up"])
    run([*base, "link", "set", "peer-" + namespace, "name", "eth0"])
    run([*base, "addr", "add", address, "dev", "eth0"])
    for value in aliases:
        run([*base, "addr", "add", value, "dev", "eth0"])
    run([*base, "-6", "addr", "add", f"2001:db8:{v6_index}::{v6_host}/64", "dev", "eth0", "nodad"])
    run([*base, "link", "set", "eth0", "up"])
    run([*base, "route", "add", "default", "via", subnet.split("/")[0]])
    run([*base, "-6", "route", "add", "default", "via", f"2001:db8:{v6_index}::1"])


def owner_rules():
    rules = []
    for peer in PEERS:
        common = ["-i", "tailscale0", "-o", "owner-hub", "-s", OWNER + "/32", "-d", peer + "/32"]
        rules += [[*common, "-p", "tcp", "-m", "multiport", "--dports", "22,80,8291", "-m", "conntrack", "--ctstate", "NEW,ESTABLISHED", "-j", "ACCEPT"],
                  [*common, "-p", "icmp", "--icmp-type", "echo-request", "-m", "conntrack", "--ctstate", "NEW,ESTABLISHED", "-j", "ACCEPT"],
                  [*common, "-p", "icmp", "-m", "conntrack", "--ctstate", "RELATED", "-j", "ACCEPT"],
                  ["-i", "owner-hub", "-o", "tailscale0", "-s", peer + "/32", "-d", OWNER + "/32", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "--ctorigsrc", OWNER + "/32", "--ctorigdst", peer + "/32", "-j", "ACCEPT"]]
    return rules


def baseline():
    for family in ("iptables", "ip6tables"):
        # Existing Docker hosts already have their compatibility NAT tables.
        run([family, "-t", "nat", "-N", "FIXTURE-EMPTY"])
        run([family, "-t", "nat", "-X", "FIXTURE-EMPTY"])
        run([family, "-N", "ONESA_WORKER_INPUT"])
        run([family, "-A", "INPUT", "-j", "ONESA_WORKER_INPUT"])
        run([family, "-A", "ONESA_WORKER_INPUT", "-i", "lo", "-j", "ACCEPT"])
        run([family, "-A", "ONESA_WORKER_INPUT", "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"])
        if family == "iptables":
            run([family, "-A", "ONESA_WORKER_INPUT", "-i", "site01", "-d", "10.91.254.1", "-p", "udp", "-m", "multiport", "--dports", "1812,1813", "-j", "ACCEPT"])
        run([family, "-A", "ONESA_WORKER_INPUT", "-i", "tailscale0", "-j", "DROP"])
        run([family, "-A", "ONESA_WORKER_INPUT", "-j", "DROP"])
        run([family, "-N", "DOCKER-USER"])
        run([family, "-N", "DOCKER-FORWARD"])
        if family == "iptables":
            for rule in owner_rules():
                run([family, "-A", "FORWARD", *rule])
            run([family, "-A", "DOCKER-USER", "-i", "wan0", "-d", DOCKER, "-p", "tcp", "--dport", "443", "-j", "ACCEPT"])
        run([family, "-A", "FORWARD", "-i", "tailscale0", "-j", "DROP"])
        run([family, "-A", "FORWARD", "-j", "DOCKER-USER"])
        run([family, "-A", "FORWARD", "-j", "DOCKER-FORWARD"])
        run([family, "-A", "DOCKER-USER", "-i", "wan0", "-m", "conntrack", "--ctstate", "NEW", "-j", "DROP"])
        run([family, "-A", "DOCKER-USER", "-j", "RETURN"])
        run([family, "-A", "DOCKER-FORWARD", "-i", "docker0", "-j", "ACCEPT"])
        run([family, "-A", "DOCKER-FORWARD", "-o", "docker0", "-j", "ACCEPT"])
        if family == "iptables":
            run([family, "-P", "FORWARD", "DROP"])
            run([family, "-A", "FORWARD", "-j", "REJECT", "--reject-with", "icmp-host-prohibited"])
    # Native guard shape follows the separately inspected owner and service
    # guards, with synthetic identities. A native ACCEPT does not override the
    # later iptables filter, and post-SNAT checks see the translated source.
    native = ["create table inet owner_guard",
              "add chain inet owner_guard input { type filter hook input priority -50; policy accept; }",
              "add chain inet owner_guard output { type filter hook output priority -50; policy accept; }",
              "add chain inet owner_guard forward { type filter hook forward priority -50; policy accept; }",
              "add chain inet owner_guard snat { type nat hook postrouting priority 101; policy accept; }",
              "add chain inet owner_guard after_snat { type filter hook postrouting priority 110; policy accept; }"]
    for peer in PEERS:
        native += [f'add rule inet owner_guard input iifname owner-hub ip saddr {peer} ip daddr 10.90.254.1 icmp type echo-reply ct state established accept',
                   f'add rule inet owner_guard input iifname owner-hub ip saddr {peer} ip daddr 10.90.254.1 ip protocol icmp ct state related accept',
                   f'add rule inet owner_guard output oifname owner-hub ip saddr 10.90.254.1 ip daddr {peer} icmp type echo-request ct state new,established accept',
                   f'add rule inet owner_guard forward iifname tailscale0 oifname owner-hub ip saddr {OWNER} ip daddr {peer} tcp dport {{22,80,8291}} ct state new,established accept',
                   f'add rule inet owner_guard forward iifname owner-hub oifname tailscale0 ip saddr {peer} ip daddr {OWNER} tcp sport {{22,80,8291}} ct state established accept',
                   f'add rule inet owner_guard forward iifname tailscale0 oifname owner-hub ip saddr {OWNER} ip daddr {peer} icmp type echo-request ct state new,established accept',
                   f'add rule inet owner_guard forward iifname owner-hub oifname tailscale0 ip saddr {peer} ip daddr {OWNER} icmp type echo-reply ct state established accept',
                   f'add rule inet owner_guard forward iifname tailscale0 oifname owner-hub ip saddr {OWNER} ip daddr {peer} ip protocol icmp ct state related accept',
                   f'add rule inet owner_guard forward iifname owner-hub oifname tailscale0 ip saddr {peer} ip daddr {OWNER} ip protocol icmp ct state related accept',
                   f'add rule inet owner_guard snat iifname tailscale0 oifname owner-hub ip saddr {OWNER} ip daddr {peer} icmp type echo-request snat ip to 10.90.254.1',
                   f'add rule inet owner_guard snat iifname tailscale0 oifname owner-hub ip saddr {OWNER} ip daddr {peer} tcp dport {{22,80,8291}} snat ip to 10.90.254.1']
    native += ['add rule inet owner_guard input iifname owner-hub drop',
               'add rule inet owner_guard output oifname owner-hub drop',
               'add rule inet owner_guard forward iifname owner-hub drop',
               'add rule inet owner_guard forward oifname owner-hub drop',
               'add rule inet owner_guard after_snat oifname owner-hub ip saddr 10.90.254.1 accept',
               'add rule inet owner_guard after_snat oifname owner-hub drop',
               'create table inet site_guard',
               'add chain inet site_guard incoming { type filter hook prerouting priority -150; policy accept; }',
               'add rule inet site_guard incoming iifname != site01 ip daddr 10.91.254.1 udp dport {1812,1813} drop',
               'add chain inet site_guard outgoing { type filter hook postrouting priority 110; policy accept; }']
    for peer in SITE:
        native += [f'add rule inet site_guard incoming iifname site01 ip saddr {peer} ip daddr 10.91.254.1 udp dport {{1812,1813}} accept',
                   f'add rule inet site_guard incoming iifname site01 ip saddr {peer} ip daddr 10.91.254.1 tcp sport 443 ct state established,related accept',
                   f'add rule inet site_guard incoming iifname site01 ip saddr {peer} ip daddr 10.91.254.1 icmp type {{echo-reply,echo-request}} accept',
                   f'add rule inet site_guard outgoing oifname site01 ip saddr 10.91.254.1 ip daddr {peer} tcp dport 443 accept',
                   f'add rule inet site_guard outgoing oifname site01 ip saddr 10.91.254.1 ip daddr {peer} icmp type {{echo-reply,echo-request}} accept',
                   f'add rule inet site_guard outgoing oifname site01 ip saddr 10.91.254.1 ip daddr {peer} udp sport {{1812,1813}} ct state established,related accept']
    native += ['add rule inet site_guard incoming iifname site01 drop',
               'add rule inet site_guard outgoing oifname site01 drop']
    run(["nft", "--file", "-"], ("\n".join(native) + "\n").encode())


NETPOL_COMMENT = "KUBE-ROUTER rule to explicitly ACCEPT traffic that comply to network policies"


def reconcile_policy_dispatch():
    # ensureTopLevelChains moves its jumps to position one. The explicit mark
    # ACCEPT is in the built-in chain, not in KUBE-ROUTER-FORWARD.
    for parent in ("INPUT", "FORWARD", "OUTPUT"):
        target = "KUBE-ROUTER-" + parent
        jump = ["-m", "comment", "--comment", "kube-router netpol", "-j", target]
        marked = ["-m", "comment", "--comment", NETPOL_COMMENT,
                  "-m", "mark", "--mark", "0x20000/0x20000", "-j", "ACCEPT"]
        for rule in (jump, marked):
            run(["iptables", "-D", parent, *rule])
        run(["iptables", "-I", parent, "1", *jump])
        run(["iptables", "-I", parent, "2", *marked])


def cluster_policy():
    # Relevant pinned source shapes: native kube-proxy base chains, Flannel
    # pod-CIDR forwarding, and kube-router's exact pod selectors/common stateful
    # chain plus a representative expansion of the declared initial policies.
    for name in ("KUBE-ROUTER-INPUT", "KUBE-ROUTER-FORWARD", "KUBE-ROUTER-OUTPUT",
                 "KUBE-NWPLCY-COMMON", "KUBE-POD-FW-APP", "KUBE-POD-FW-DNS", "FLANNEL-FWD"):
        run(["iptables", "-N", name])
    run(["iptables", "-A", "KUBE-NWPLCY-COMMON", "-m", "conntrack", "--ctstate", "INVALID", "-j", "DROP"])
    run(["iptables", "-A", "KUBE-NWPLCY-COMMON", "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"])
    for address, name in ((POD, "KUBE-POD-FW-APP"), (DNS_POD, "KUBE-POD-FW-DNS")):
        run(["iptables", "-A", name, "-m", "addrtype", "--src-type", "LOCAL", "-d", address, "-j", "ACCEPT"])
        run(["iptables", "-A", name, "-j", "KUBE-NWPLCY-COMMON"])
        run(["iptables", "-A", name, "-j", "MARK", "--set-xmark", "0/0x10000"])
        allowed = [["-s", address, "-d", NODE, "-p", "tcp", "--dport", "6443"]]
        if address == POD:
            allowed += [["-s", POD, "-d", DNS_POD, "-p", protocol, "--dport", "53"] for protocol in ("udp", "tcp")]
        else:
            allowed += [["-s", DNS_POD, "-d", UPSTREAM, "-p", protocol, "--dport", "53"] for protocol in ("udp", "tcp")]
            allowed += [["-s", PODS, "-d", DNS_POD, "-p", protocol, "--dport", "53"] for protocol in ("udp", "tcp")]
        for rule in allowed:
            run(["iptables", "-A", name, *rule, "-j", "MARK", "--set-xmark", "0x10000/0x10000"])
        run(["iptables", "-A", name, "-m", "mark", "!", "--mark", "0x10000/0x10000", "-j", "REJECT"])
        run(["iptables", "-A", name, "-j", "MARK", "--set-xmark", "0/0x10000"])
        run(["iptables", "-A", name, "-j", "MARK", "--set-xmark", "0x20000/0x20000"])
        for parent in ("INPUT", "FORWARD", "OUTPUT"):
            run(["iptables", "-A", "KUBE-ROUTER-" + parent, "-s", address, "-j", name])
        for parent in ("FORWARD", "OUTPUT"):
            run(["iptables", "-A", "KUBE-ROUTER-" + parent, "-d", address, "-j", name])
    for parent in ("INPUT", "FORWARD", "OUTPUT"):
        run(["iptables", "-I", parent, "1", "-m", "comment", "--comment", "kube-router netpol", "-j", "KUBE-ROUTER-" + parent])
        run(["iptables", "-I", parent, "2", "-m", "comment", "--comment", NETPOL_COMMENT,
             "-m", "mark", "--mark", "0x20000/0x20000", "-j", "ACCEPT"])
    run(["iptables", "-A", "FLANNEL-FWD", "-s", PODS, "-j", "ACCEPT"])
    run(["iptables", "-A", "FLANNEL-FWD", "-d", PODS, "-j", "ACCEPT"])
    run(["iptables", "-A", "FORWARD", "-j", "FLANNEL-FWD"])
    run(["iptables", "-t", "nat", "-N", "FLANNEL-POSTRTG"])
    run(["iptables", "-t", "nat", "-A", "POSTROUTING", "-j", "FLANNEL-POSTRTG"])
    run(["iptables", "-t", "nat", "-A", "FLANNEL-POSTRTG", "-s", PODS, "!", "-d", PODS, "-j", "MASQUERADE"])
    native = ["create table ip kube-proxy",
              "add chain ip kube-proxy filter-forward { type filter hook forward priority 0; policy accept; }",
              "add chain ip kube-proxy service-endpoints-check",
              "add chain ip kube-proxy cluster-ips-check",
              "add rule ip kube-proxy filter-forward ct state new jump service-endpoints-check",
              "add rule ip kube-proxy filter-forward ct state new jump cluster-ips-check",
              "add chain ip kube-proxy nat-prerouting { type nat hook prerouting priority -100; policy accept; }",
              "add chain ip kube-proxy nat-output { type nat hook output priority -100; policy accept; }"]
    for hook in ("nat-prerouting", "nat-output"):
        native += [f"add rule ip kube-proxy {hook} ip daddr 10.121.0.1 tcp dport 443 dnat to {NODE}:6443"]
        for protocol in ("udp", "tcp"):
            native += [f"add rule ip kube-proxy {hook} ip daddr 10.121.0.10 {protocol} dport 53 dnat to {DNS_POD}:53"]
    run(["nft", "--file", "-"], ("\n".join(native) + "\n").encode())


PERSISTENT_UDP = r'''
import socket,sys
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(0.5)
s.bind((sys.argv[1],0));s.connect((sys.argv[2],9999))
print('READY',flush=True)
for line in sys.stdin:
 try:s.send(b'probe');print('PASS' if s.recv(32)==b'qualified' else 'FAIL',flush=True)
 except OSError:print('BLOCKED',flush=True)
'''


def persistent_probe(process):
    process.stdin.write(b"probe\n")
    process.stdin.flush()
    value = readline(process)
    require(value in {b"PASS", b"BLOCKED"}, "PERSISTENT_CLIENT_FAILED")
    return value == b"PASS"


def policy_routing_fixture():
    # These are the observed Tailscale selectors, without any change to a live
    # Tailscale device. A distinct table-52 route makes route selection visible.
    for family, destination, gateway in (("-4", WAN + "/32", "198.51.100.2"),
                                         ("-6", "2001:db8:5::2/128", "2001:db8:7::2")):
        run(["ip", family, "route", "add", "table", "52", destination, "via", gateway, "dev", "policy0"])
        for priority, operation in (("5210", ["lookup", "main"]), ("5230", ["lookup", "default"]), ("5250", ["unreachable"])):
            run(["ip", family, "rule", "add", "pref", priority, "fwmark", "0x80000/0xff0000", *operation])
        run(["ip", family, "rule", "add", "pref", "5270", "lookup", "52"])
    for family in ("ip", "ip6"):
        rules = [f"create table {family} fixture_marks",
                 f"add chain {family} fixture_marks mark_in {{ type filter hook prerouting priority -150; policy accept; }}",
                 f"add rule {family} fixture_marks mark_in iifname docker0 udp dport 9998 meta mark set 0xa0000",
                 f"add rule {family} fixture_marks mark_in iifname docker0 udp dport 9997 meta mark set 0x80000",
                 f"add rule {family} fixture_marks mark_in iifname tailscale0 udp dport 9999 meta mark set 0x20000",
                 f"add chain {family} fixture_marks observe_out {{ type filter hook postrouting priority 150; policy accept; }}",
                 f"add rule {family} fixture_marks observe_out oifname policy0 udp dport 9998 meta mark 0x80000 counter comment post-route-clear",
                 f"add rule {family} fixture_marks observe_out oifname wan0 udp dport 9997 meta mark 0x80000 counter comment retained-route-mark",
                 f"add rule {family} fixture_marks observe_out oifname policy0 udp dport 9997 counter comment unexpected-output-route"]
        run(["nft", "--file", "-"], ("\n".join(rules) + "\n").encode())


def route_mark_counts():
    result = {}
    for family in ("ip", "ip6"):
        rows = json.loads(run(["nft", "--json", "list", "chain", family, "fixture_marks", "observe_out"]))["nftables"]
        for item in rows:
            rule = item.get("rule", {})
            if rule.get("comment") in {"post-route-clear", "retained-route-mark", "unexpected-output-route"}:
                result[family + "/" + rule["comment"]] = next(expr["counter"]["packets"] for expr in rule["expr"] if "counter" in expr)
    return result


def child(parent, progress):
    progress.update(phase="CHILD_ISOLATION", namespace_creation_attempted=True)
    require(os.geteuid() == 0, "ROOT_REQUIRED")
    for namespace in ("net", "mnt", "pid"):
        require(os.readlink("/proc/self/ns/" + namespace) != parent["namespaces"][namespace], "ISOLATION_NOT_ESTABLISHED")
    require(os.getpid() == 1, "PRIVATE_PID_NAMESPACE_REQUIRED")
    require(source_pins() == parent["source_sha256"], "CHILD_SOURCE_CHANGED")
    progress.update(phase="CHILD_BRIDGE_PREREQUISITES", isolated_child_verified=True)
    # Recheck inside the child before its first mutation. The fixture never
    # loads a module or changes either host or child bridge-filter sysctls.
    bridge_prerequisites()
    progress["phase"] = "ISOLATED_NETWORK_SETUP"
    # Every following mutation is inside all three verified namespaces.
    require(not str(ROOT).startswith("/run/"), "SOURCE_MUST_REMAIN_OUTSIDE_PRIVATE_RUN_MOUNT")
    run(["mount", "-t", "tmpfs", "-o", "mode=0700", "onesa-net-test", "/run"])
    Path("/run/netns").mkdir(mode=0o700)
    run(["ip", "link", "set", "lo", "up"])
    run(["ip", "addr", "add", NODE + "/32", "dev", "lo"])
    run(["sysctl", "-q", "-w", "net.ipv4.ip_forward=1"])
    run(["sysctl", "-q", "-w", "net.ipv6.conf.all.forwarding=1"])
    network("owner", "tailscale0", "100.64.10.1/24", OWNER + "/24", 1, ("100.64.10.99/24",))
    network("router", "owner-hub", "10.90.254.1/24", PEERS[0] + "/24", 2, (PEERS[1] + "/24",))
    run(["ip", "link", "add", "cni0", "type", "bridge"])
    run(["ip", "addr", "add", "10.120.0.1/16", "dev", "cni0"])
    run(["ip", "-6", "addr", "add", "2001:db8:3::1/64", "dev", "cni0", "nodad"])
    run(["ip", "link", "set", "cni0", "up"])
    network("pod", "veth-app", "10.120.0.1/16", POD + "/16", 3, bridge="cni0")
    network("dns", "veth-dns", "10.120.0.1/16", DNS_POD + "/16", 3, bridge="cni0", v6_host=3)
    network("docker", "docker0", "172.18.0.1/16", DOCKER + "/16", 4)
    network("wan", "wan0", "192.0.2.1/24", WAN + "/24", 5, (UPSTREAM + "/32",))
    run(["ip", "route", "add", UPSTREAM + "/32", "via", WAN, "dev", "wan0"])
    network("site", "site01", "10.91.254.1/24", SITE[0] + "/24", 6, (SITE[1] + "/24",))
    network("policy", "policy0", "198.51.100.1/24", "198.51.100.2/24", 7, (WAN + "/32",))
    run(["ip", "netns", "exec", "policy", "ip", "-6", "addr", "add", "2001:db8:5::2/128", "dev", "eth0", "nodad"])
    servers = [start_server("router", [22, 23, 80, 8291], []), start_server("site", [443], []),
               start_server("docker", [443, 5432], []),
               start_server("wan", [53, 80, 443], [53, 9997, 9998, 9999], (WAN, UPSTREAM), ("2001:db8:5::2",)),
               start_server("policy", [443], [9997, 9998, 9999], (WAN,), ("2001:db8:5::2",)),
               start_server("pod", [9443], []), start_server("dns", [53, 9443], [53]),
               start_server(None, [6443, 10250], [1812, 1813])]
    persistent = None
    try:
        baseline()
        sys.path.insert(0, str(ROOT / "infra/oracle"))
        import k3s_first_install as installer
        original_native = installer.snapshot_native_guards()
        original_filter = installer.snapshot_firewall()
        cases = []

        def observed_case(label, passed):
            cases.append({"case": label, "passed": bool(passed)})
            require(passed, "PACKET_CASE_FAILED:" + label)

        def check(label, expected, namespace, target, port, **kwargs):
            observed_case(label, probe(namespace, target, port, **kwargs) == expected)

        def retained(prefix):
            for index, peer in enumerate(PEERS):
                for port in (22, 80, 8291):
                    check(f"{prefix}/owner-{index}-{port}", True, "owner", peer, port, source=OWNER)
                check(f"{prefix}/wrong-owner-{index}", False, "owner", peer, 22, source="100.64.10.99")
                check(f"{prefix}/wrong-port-{index}", False, "owner", peer, 23, source=OWNER)
            check(prefix + "/public-https", True, "wan", DOCKER, 443)
            check(prefix + "/public-database-denied", False, "wan", DOCKER, 5432)
            for index, peer in enumerate(SITE):
                check(f"{prefix}/radius-site-{index}", True, "site", "10.91.254.1", 1812, protocol="udp", source=peer)
                check(f"{prefix}/service-control-{index}", True, None, peer, 443, source="10.91.254.1")
            check(prefix + "/radius-wrong-interface", False, "owner", "10.91.254.1", 1812, protocol="udp")

        progress.update(phase="RETAINED_PACKET_BASELINE", packet_cases_started=True)
        retained("baseline")
        progress["phase"] = "LEGACY_PROXY_COUNTEREXAMPLE"
        # Keep a real conntrack entry alive while removing its authorization.
        # This must fail with the old unscoped iptables kube-proxy ACCEPTs, so a
        # test that never creates established traffic cannot produce a false pass.
        temporary = [
            ["-i", "tailscale0", "-s", OWNER, "-d", WAN, "-p", "udp", "--dport", "9999", "-j", "ACCEPT"],
            ["-s", WAN, "-d", OWNER, "-p", "udp", "--sport", "9999", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
        ]
        for rule in temporary:
            run(["iptables", "-I", "FORWARD", "1", *rule])
        persistent = subprocess.Popen([shutil.which("ip", path=SAFE_PATH), "netns", "exec", "owner", sys.executable,
                                       "-I", "-B", "-S", "-c", PERSISTENT_UDP, OWNER, WAN],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=ENV)
        require(readline(persistent) == b"READY", "PERSISTENT_CLIENT_NOT_READY")
        observed_case("revocation/temporary-permit-established", persistent_probe(persistent))
        run(["iptables", "-D", "FORWARD", *temporary[0]])
        observed_case("revocation/retained-policy-blocks-established", not persistent_probe(persistent))
        run(["iptables", "-N", "KUBE-FORWARD"])
        run(["iptables", "-A", "KUBE-FORWARD", "-m", "mark", "--mark", "0x4000/0x4000", "-j", "ACCEPT"])
        run(["iptables", "-A", "KUBE-FORWARD", "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"])
        run(["iptables", "-I", "FORWARD", "1", "-j", "KUBE-FORWARD"])
        observed_case("counterexample/old-proxy-bypasses-revocation", persistent_probe(persistent))
        run(["iptables", "-D", "FORWARD", "-j", "KUBE-FORWARD"])
        run(["iptables", "-F", "KUBE-FORWARD"])
        run(["iptables", "-X", "KUBE-FORWARD"])
        observed_case("revocation/unsafe-proxy-removed", not persistent_probe(persistent))
        progress["phase"] = "CANDIDATE_NETWORK_SETUP"
        policy_routing_fixture()
        routes = installer.snapshot_policy_routes()
        # Cold-start ordering: the persistent native guard is installed before
        # any standard K3s controller can grant pod forwarding.
        installer.STATE = Path("/run/onesa-qualification")
        installer.STATE.mkdir(mode=0o700)
        installer.RECEIPT = installer.STATE / "installation.json"
        source = installer.native_guard_source(plan(), ["172.18.0.0/16"])
        installer.write_new(installer.STATE / "private-firewall.nft", source)
        receipt = {"native_before": original_native, "docker_subnets": ["172.18.0.0/16"]}
        installer.ensure_native_guard(plan(), receipt, first_install=True)
        installer.apply_private_firewall(plan(), ["172.18.0.0/16"])
        cluster_policy()
        progress["phase"] = "CANDIDATE_PACKET_CASES"
        retained("nftables-candidate")
        observed_case("revocation/nftables-keeps-established-marked-denial", not persistent_probe(persistent))
        for namespace in ("pod", "dns"):
            check(namespace + "/private-api", True, namespace, NODE, 6443)
            check(namespace + "/api-service-dnat", True, namespace, "10.121.0.1", 443)
            check(namespace + "/metadata-http-denied", False, namespace, UPSTREAM, 80)
            check(namespace + "/docker-database-denied", False, namespace, DOCKER, 5432)
            check(namespace + "/router-service-denied-before-snat", False, namespace, SITE[0], 443)
        for protocol in ("tcp", "udp"):
            check("coredns/upstream-" + protocol, True, "dns", UPSTREAM, 53, protocol=protocol)
            check("non-coredns/upstream-" + protocol + "-denied", False, "pod", UPSTREAM, 53, protocol=protocol)
            check("pod/coredns-service-" + protocol, True, "pod", "10.121.0.10", 53, protocol=protocol)
        check("pod/combined-peer-policy-denied", False, "dns", POD, 9443)
        check("pod/coredns-nondns-port-denied", False, "pod", DNS_POD, 9443)
        check("pod/router-owner-plane-denied", False, "pod", PEERS[0], 22)
        check("pod/radius-wrong-interface", False, "pod", "10.91.254.1", 1812, protocol="udp")
        check("public/portainer-denied", False, "wan", POD, 9443)
        check("owner/portainer-network-denied", False, "owner", POD, 9443)
        check("docker/portainer-denied", False, "docker", POD, 9443)
        check("owner/private-api-denied", False, "owner", NODE, 6443)
        check("owner/private-kubelet-denied", False, "owner", NODE, 10250)
        check("host/portainer-private-access", True, None, POD, 9443)
        check("ipv6/pod-egress-denied", False, "pod", "2001:db8:5::2", 443)
        check("ipv6/portainer-ingress-denied", False, "wan", "2001:db8:3::2", 9443)
        progress["phase"] = "POLICY_ROUTING_MARKS"
        before_routes = route_mark_counts()
        for destination, family in ((WAN, "ipv4"), ("2001:db8:5::2", "ipv6")):
            check(f"{family}/injected-mark-routes-before-clear", True, "docker", destination, 9998, protocol="udp")
            check(f"{family}/retained-incoming-route-mark", True, "docker", destination, 9997, protocol="udp")
            host_before = route_mark_counts()
            check(f"{family}/host-tailscale-mark-preserved", True, None, destination, 9997, protocol="udp", mark=0x80000)
            host_after = route_mark_counts()
            nft_family = "ip" if family == "ipv4" else "ip6"
            expected = nft_family + "/retained-route-mark"
            alternate = nft_family + "/unexpected-output-route"
            observed_case(f"{family}/host-output-main-route-proved",
                          host_after[expected] > host_before[expected]
                          and host_after[alternate] == host_before[alternate])
        after_routes = route_mark_counts()
        exercised = {family + "/" + purpose for family in ("ip", "ip6")
                     for purpose in ("post-route-clear", "retained-route-mark")}
        observed_case("policy-routing/both-families-route-and-mark-proved",
                      exercised.issubset(after_routes)
                      and all(after_routes[key] > before_routes[key] for key in exercised)
                      and all(after_routes[family + "/unexpected-output-route"] == 0 for family in ("ip", "ip6")))
        # Owner reconcile and then kube-router reconcile deliberately change
        # relative parent-chain order. Native restrictions must stay authoritative.
        progress["phase"] = "CONTROLLER_RECONCILIATION"
        for rule in reversed(owner_rules()):
            run(["iptables", "-D", "FORWARD", *rule])
            run(["iptables", "-I", "FORWARD", "1", *rule])
        retained("owner-reconcile")
        reconcile_policy_dispatch()
        retained("policy-reconcile")
        observed_case("reconcile/established-marked-denial-retained", not persistent_probe(persistent))
        check("reconcile/coredns-upstream", True, "dns", UPSTREAM, 53, protocol="udp")
        check("reconcile/non-coredns-upstream-denied", False, "pod", UPSTREAM, 53, protocol="udp")
        # Only our new table is removed, in this disposable namespace, to model
        # restoration of its retained source after a cold kernel restart.
        progress["phase"] = "GUARD_RESTORATION"
        run(["nft", "delete", "table", "inet", installer.NATIVE_TABLE])
        installer.ensure_native_guard(plan(), receipt)
        installer.apply_private_firewall(plan(), ["172.18.0.0/16"])
        reconcile_policy_dispatch()
        check("guard-restore/coredns-upstream", True, "dns", UPSTREAM, 53, protocol="udp")
        check("guard-restore/metadata-denied", False, "dns", UPSTREAM, 80)
        observed_case("guard-restore/legacy-established-denial", not persistent_probe(persistent))
        progress["phase"] = "FINAL_ISOLATED_VERIFICATION"
        run(["iptables", "-D", "FORWARD", *temporary[1]])
        require(installer.snapshot_native_guards() == original_native, "ORIGINAL_NATIVE_GUARDS_CHANGED")
        require(installer.snapshot_policy_routes() == routes, "POLICY_ROUTE_SELECTORS_CHANGED")
        installer.verify_firewall(plan(), ["172.18.0.0/16"], original_filter)
        installer.verify_nftables_proxy()
        require(source_pins() == parent["source_sha256"], "CHILD_SOURCE_CHANGED")
        return {"status": "ISOLATED_PACKET_QUALIFICATION_PASS", "cases": cases,
                "original_native_guards_preserved": True, "policy_route_selectors_preserved": True,
                "installation_performed": False, "runtime_cluster_started": False, "host_reboot_performed": False,
                "fixture_scope": "synthetic-routing-native-guards-and-pinned-controller-rule-shapes",
                "runtime_service_account_authentication_qualified": False}
    finally:
        if persistent is not None:
            servers.append(persistent)
        for server in servers:
            server.terminate()
        for server in servers:
            try:
                server.wait(timeout=2)
            except subprocess.TimeoutExpired:
                server.kill()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--isolated-child")
    args = parser.parse_args()
    progress = {"phase": "PARENT_IDENTITY", "namespace_creation_attempted": False,
                "isolated_child_verified": False, "packet_cases_started": False}
    evidence = {}
    try:
        if args.isolated_child:
            progress["phase"] = "CHILD_ARGUMENTS"
            result = child(json.loads(args.isolated_child), progress)
            result.update(progress)
        else:
            require(os.geteuid() == 0, "ROOT_REQUIRED_FOR_NAMESPACE_TEST")
            progress["phase"] = "PARENT_SOURCE_CUSTODY"
            pins = source_pins()
            evidence["source_sha256"] = pins
            progress["phase"] = "PARENT_BRIDGE_PREREQUISITES"
            bridge_prerequisites()
            progress["phase"] = "PARENT_NETWORK_FINGERPRINT"
            before = fingerprints()
            namespaces = {name: os.readlink("/proc/self/ns/" + name) for name in ("net", "mnt", "pid")}
            unshare = shutil.which("unshare", path=SAFE_PATH)
            require(unshare, "UNSHARE_UNAVAILABLE")
            started = time.monotonic()
            progress.update(phase="ISOLATED_CHILD_EXECUTION", namespace_creation_attempted=True,
                            isolated_child_verified=None, packet_cases_started=None)
            completed = subprocess.run([unshare, "--mount", "--net", "--pid", "--fork", "--kill-child=KILL", "--mount-proc", "--propagation", "private",
                                        sys.executable, "-I", "-B", "-S", str(Path(__file__).resolve()),
                                        "--isolated-child", json.dumps({"namespaces": namespaces, "source_sha256": pins})],
                                       capture_output=True, timeout=150, env=ENV, check=False)
            progress["phase"] = "PARENT_POST_RUN_VERIFICATION"
            require(source_pins() == pins, "PARENT_SOURCE_CHANGED")
            require(fingerprints() == before, "HOST_NETWORK_CONFIGURATION_CHANGED_DURING_TEST")
            require(len(completed.stdout) <= 65536, "OVERSIZED_CHILD_RESULT")
            try:
                result = json.loads(completed.stdout)
            except ValueError:
                raise Failed("ISOLATION_OR_FIXTURE_UNAVAILABLE") from None
            result.update({"host_network_configuration_unchanged": True,
                           "duration_seconds": round(time.monotonic() - started, 2), "source_sha256": pins, "fingerprint_scope": "iptables-ip6tables-native-inet-ipv4-ipv6-routes-and-rules"})
            require(completed.returncode == 0 or result.get("status") == "BLOCKED", "CHILD_PROCESS_FAILED")
        print(json.dumps(result, sort_keys=True))
        return 0 if result["status"].endswith("PASS") else 2
    except (Failed, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        reason = str(error) if isinstance(error, Failed) else type(error).__name__
        print(json.dumps({"status": "BLOCKED", "reason": reason, "error_type": type(error).__name__,
                          "installation_performed": False, **progress, **evidence}, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
