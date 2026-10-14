"""Offline SSH allowlist guards; no real firewall or hosted access is exercised."""

import importlib.util
import contextlib
import io
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("admin_sources", ROOT / "infra/oracle/admin-sources.py")
sources = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sources)


class SourceValidation(unittest.TestCase):
    def test_tailscale_peer_is_separate_exact_cgnat_ipv4_source(self):
        for value in ["100.64.0.1/32", "100.101.102.103/32", "100.127.255.254/32"]:
            with patch.object(sources, "read_protected_text", return_value=value + "\n"):
                self.assertEqual(sources.read_tailscale_peer("synthetic-root-file"), value)
        for value in ["100.64.0.0/10", "100.101.102.0/24", "8.8.8.8/32", "10.0.0.1/32", "100.128.0.1/32", "fd7a:115c:a1e0::1/128", "100.101.102.103/32\n100.101.102.104/32", "", "synthetic-invalid-private-value"]:
            with patch.object(sources, "read_protected_text", return_value=value), self.assertRaises(ValueError):
                sources.read_tailscale_peer("synthetic-root-file")

    def test_tailscale_cli_cannot_mix_with_public_source_or_session_validation(self):
        for extra in [["--file", "other-file"], ["8.8.8.8/32"], ["--require-ssh-session"]]:
            with patch.object(sys, "argv", ["admin-sources.py", "--tailscale-peer-file", "synthetic-root-file", *extra]), self.assertRaises(ValueError):
                sources.main()

    def test_existing_sources_and_new_network_are_retained_without_duplicates(self):
        self.assertEqual(sources.normalize(["8.8.8.8/32", "1.1.1.1/32", "8.8.8.8/32"]), ["8.8.8.8/32", "1.1.1.1/32"])

    def test_cli_addition_preserves_existing_sources_and_accepts_existing_session(self):
        output = io.StringIO()
        with (
            patch.object(sources, "read_sources", return_value=["8.8.8.8/32"]),
            patch.object(sys, "argv", ["admin-sources.py", "--file", "synthetic-root-file", "--require-ssh-session", "1.1.1.1/32"]),
            patch.dict(os.environ, {"SSH_CONNECTION": "8.8.8.8 54321 10.0.0.2 22"}),
            contextlib.redirect_stdout(output),
        ):
            sources.main()
        self.assertEqual(output.getvalue().splitlines(), ["8.8.8.8/32", "1.1.1.1/32"])

    def test_broad_private_ipv6_missing_and_malformed_sources_are_rejected(self):
        for values in [[], ["0.0.0.0/0"], ["8.8.8.0/24"], ["10.0.0.1/32"], ["127.0.0.1/32"], ["::/0"], ["2606:4700:4700::1111/128"], ["example.invalid"], ["8.8.8.8/32;true"], ["8.8.8.8/32", ""]]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                sources.normalize(values)

    def test_current_ssh_source_must_match_an_approved_network_and_port(self):
        allowed = ["8.8.8.8/32", "1.1.1.1/32"]
        for source in ["8.8.8.8", "1.1.1.1"]:
            sources.require_session(allowed, source + " 54321 10.0.0.2 22")
        for connection in ["", "9.9.9.9 54321 10.0.0.2 22", "8.8.8.8 54321 10.0.0.2 2222", "8.8.8.8 malformed"]:
            with self.subTest(connection=connection), self.assertRaises(ValueError):
                sources.require_session(allowed, connection)

    def test_unprivileged_or_writable_source_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sources"
            path.write_text("8.8.8.8/32\n")
            metadata = list(path.stat())
            for owner, mode in [(1, 0o600), (0, 0o644), (0, 0o666)]:
                metadata[0] = stat.S_IFREG | mode
                metadata[4] = owner
                with patch.object(sources.os, "fstat", return_value=os.stat_result(metadata)), self.assertRaises(ValueError):
                    sources.read_sources(path)
            metadata[0], metadata[4] = stat.S_IFREG | 0o600, 0
            with patch.object(sources.os, "fstat", return_value=os.stat_result(metadata)):
                self.assertEqual(sources.read_sources(path), ["8.8.8.8/32"])

    def test_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sources"
            path.write_text("8.8.8.8/32\n")
            link = Path(directory) / "link"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                sources.read_sources(link)

    def test_fifo_is_rejected_without_waiting_for_a_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sources"
            os.mkfifo(path, 0o600)
            with self.assertRaises(ValueError):
                sources.read_sources(path)

    def test_invalid_content_is_not_copied_into_validation_errors(self):
        sentinel = "synthetic-private-value-not-an-address"
        with self.assertRaises(ValueError) as error:
            sources.normalize([sentinel])
        self.assertNotIn(sentinel, str(error.exception))


class FirewallCommands(unittest.TestCase):
    def execute(self, content, mode=0o600, peer=None, peer_mode=0o600):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            source_file, log = folder / "sources", folder / "commands"
            source_file.write_text(content)
            source_file.chmod(mode)
            peer_file = folder / "tailscale-peer"
            if peer is not None:
                peer_file.write_text(peer)
                peer_file.chmod(peer_mode)
            wrapper = folder / "validate.py"
            wrapper.write_text(
                "import os,runpy,sys\nfrom unittest.mock import patch\n"
                + "original=os.fstat\ndef root_stat(fd):\n value=list(original(fd));value[4]=0;return os.stat_result(value)\n"
                + "flag='--tailscale-peer-file' if '--tailscale-peer-file' in sys.argv else '--file'\n"
                + "path=" + repr(str(peer_file)) + " if flag=='--tailscale-peer-file' else " + repr(str(source_file)) + "\n"
                + "sys.argv=[" + repr(str(ROOT / "infra/oracle/admin-sources.py")) + ",flag,path]\n"
                + "with patch('os.fstat',side_effect=root_stat):runpy.run_path(sys.argv[0],run_name='__main__')\n"
            )
            validator = folder / "python3"
            validator.write_text("#!/bin/sh\nexec " + shlex.quote(sys.executable) + " " + shlex.quote(str(wrapper)) + ' "$@"\n')
            validator.chmod(0o700)
            for tool in ["iptables", "ip6tables"]:
                executable = folder / tool
                executable.write_text("#!/bin/sh\nprintf '%s\\n' " + shlex.quote(tool) + ' "$*" >> ' + shlex.quote(str(log)) + "\n")
                executable.chmod(0o700)
            route = folder / "ip"
            route.write_text("#!/bin/sh\nprintf '%s\\n' 'default via 10.0.0.1 dev eth0'\n")
            route.chmod(0o700)
            firewall = folder / "firewall.sh"
            firewall.write_text((ROOT / "infra/oracle/worker-firewall.sh").read_text().replace("/etc/onesa/worker-tailscale-peer", str(peer_file)))
            result = subprocess.run(["sh", str(firewall)], env={**os.environ, "PATH": str(folder) + os.pathsep + os.environ["PATH"]}, capture_output=True, text=True)
            commands = log.read_text().splitlines() if log.exists() else []
            return result.returncode, commands

    def test_each_network_allows_only_tcp_22_and_preserves_other_boundaries(self):
        code, commands = self.execute("8.8.8.8/32\n1.1.1.1/32\n9.9.9.9/32\n")
        self.assertEqual(code, 0)
        ipv4 = [commands[index + 1] for index, value in enumerate(commands) if value == "iptables"]
        allowed = [rule for rule in ipv4 if " -s " in rule]
        self.assertEqual(allowed, ["-A ONESA_WORKER_INPUT -s " + source + " -p tcp --dport 22 -j ACCEPT" for source in ["8.8.8.8/32", "1.1.1.1/32", "9.9.9.9/32"]])
        self.assertIn("-A ONESA_WORKER_INPUT -j DROP", ipv4)
        self.assertIn("-C DOCKER-USER -i eth0 -m conntrack --ctstate NEW -j DROP", ipv4)
        self.assertFalse(any(rule.startswith("-F ") and rule != "-F ONESA_WORKER_INPUT" for rule in ipv4))
        ipv6 = [commands[index + 1] for index, value in enumerate(commands) if value == "ip6tables"]
        self.assertFalse(any("--dport 22" in rule for rule in ipv6))

    def test_single_existing_source_remains_compatible(self):
        code, commands = self.execute("8.8.8.8/32\n")
        self.assertEqual(code, 0)
        self.assertEqual(sum("--dport 22" in rule for rule in commands), 1)

    def test_overlay_ssh_accepts_only_one_peer_on_correct_interface_and_blocks_forwarding(self):
        code, commands = self.execute("8.8.8.8/32\n", peer="100.101.102.103/32\n")
        self.assertEqual(code, 0)
        ipv4 = [commands[index + 1] for index, value in enumerate(commands) if value == "iptables"]
        self.assertIn("-A ONESA_WORKER_INPUT -i tailscale0 -s 100.101.102.103/32 -p tcp --dport 22 -j ACCEPT", ipv4)
        self.assertIn("-A ONESA_WORKER_INPUT -i tailscale0 -j DROP", ipv4)
        self.assertIn("-C FORWARD -i tailscale0 -j DROP", ipv4)
        self.assertLess(ipv4.index("-A ONESA_WORKER_INPUT -i tailscale0 -j DROP"), ipv4.index("-A ONESA_WORKER_INPUT -p icmp -j ACCEPT"))
        ipv6 = [commands[index + 1] for index, value in enumerate(commands) if value == "ip6tables"]
        self.assertIn("-A ONESA_WORKER_INPUT -i tailscale0 -j DROP", ipv6)
        self.assertIn("-C FORWARD -i tailscale0 -j DROP", ipv6)
        self.assertFalse(any("--dport 22" in rule for rule in ipv6))

    def test_missing_overlay_approval_still_drops_overlay_and_never_accepts_it(self):
        code, commands = self.execute("8.8.8.8/32\n")
        self.assertEqual(code, 0)
        self.assertIn("-A ONESA_WORKER_INPUT -i tailscale0 -j DROP", commands)
        self.assertFalse(any("-i tailscale0" in rule and "-j ACCEPT" in rule for rule in commands))

    def test_invalid_overlay_peer_refuses_all_firewall_mutations(self):
        for peer, mode in [("100.64.0.0/10\n", 0o600), ("100.101.102.103/32\n", 0o644), ("8.8.8.8/32\n", 0o600), ("", 0o600)]:
            with self.subTest(peer=peer, mode=mode):
                code, commands = self.execute("8.8.8.8/32\n", peer=peer, peer_mode=mode)
                self.assertNotEqual(code, 0)
                self.assertEqual(commands, [])

    def test_invalid_or_unprotected_allowlist_never_reaches_firewall_commands(self):
        for content, mode in [("8.8.8.8/32\n0.0.0.0/0\n", 0o600), ("", 0o600), ("8.8.8.8/32\n", 0o644)]:
            with self.subTest(content=content, mode=mode):
                code, commands = self.execute(content, mode)
                self.assertNotEqual(code, 0)
                self.assertEqual(commands, [])


if __name__ == "__main__":
    unittest.main()
