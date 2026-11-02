"""Actual Docker CLI wire-contract regression; a fake local Engine refuses creation.

No daemon, container, image pull, external connection or application credential is
used. The CLI is an existing build/test prerequisite, not an optional skipped gate.
"""

import copy
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

import oracle_recovery_smoke as smoke

recovery = smoke.load_recovery()
IMAGE = "sha256:" + "b" * 64
SOURCE = "c" * 40


class EngineHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_arguments):
        pass

    def do_HEAD(self):
        if self.path != "/_ping":
            self.server.unexpected = True
        self.send_response(200)
        self.send_header("Api-Version", self.server.api_version)
        self.send_header("OSType", "linux")
        self.end_headers()

    def do_GET(self):
        self.do_HEAD()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if (
            not re.fullmatch(r"/v[0-9]{1,3}\.[0-9]{1,3}/containers/create", urlsplit(self.path).path)
            or not 0 < length <= 65536
        ):
            self.server.unexpected = True
        else:
            self.server.creates.append(json.loads(self.rfile.read(length)))
        # The test observes only serialized input. The endpoint always refuses
        # creation, so Docker cannot proceed to attach/start/pull or any process.
        raw = b'{"message":"Synthetic endpoint refuses actual creation"}'
        self.send_response(500)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class RecoverySmokeTests(unittest.TestCase):
    def setUp(self):
        self.cli = shutil.which("docker")
        self.assertIsNotNone(self.cli, "Existing Docker CLI test prerequisite required")
        temporary = tempfile.TemporaryDirectory(prefix="onesa-recovery-wire-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.root.chmod(0o700)
        self.socket = self.root / "engine.sock"
        self.server = socketserver.UnixStreamServer(str(self.socket), EngineHandler)
        self.server.creates = []
        self.server.unexpected = False
        self.server.api_version = "1.52"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)
        self.fixtures = smoke.Fixtures(IMAGE, self.root)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.assertFalse(self.thread.is_alive())

    def capture_fixture_create(self, security_option=None):
        def command(*arguments, **_options):
            self.assertEqual(arguments[0], "run")
            arguments = list(arguments)
            if security_option is not None:
                arguments[arguments.index("--security-opt") + 1] = security_option
            result = subprocess.run(
                [
                    self.cli, "--host", "unix://" + str(self.socket),
                    "--config", str(self.root / "empty-client"), *arguments,
                ],
                env={"PATH": "/usr/bin:/bin", "LANG": "C"},
                capture_output=True, timeout=10, check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            # Mirror the fixture's command failure boundary, not a fake success.
            smoke.require(result.returncode == 0, "Isolated Docker fixture command failed")

        previous = len(self.server.creates)
        with patch.dict(os.environ, {"GITHUB_SHA": SOURCE}), patch.object(
            self.fixtures, "command", side_effect=command
        ):
            with self.assertRaisesRegex(ValueError, "Isolated Docker fixture command failed"):
                self.fixtures.create("api")
        self.assertFalse(self.server.unexpected)
        self.assertEqual(len(self.server.creates), previous + 1)
        self.assertEqual(self.fixtures.owned, {})
        return self.server.creates[-1]

    def observation(self, request):
        # Image-inherited defaults are the retained backend contract. All launch
        # flags, including SecurityOpt, come from the actual CLI request bytes.
        config = {
            key: copy.deepcopy(value) for key, value in request.items()
            if key not in {"HostConfig", "NetworkingConfig"}
        }
        for key, default in {
            "User": "node", "Entrypoint": ["docker-entrypoint.sh"],
            "Cmd": ["node", "dist/src/server.js"],
        }.items():
            if not config.get(key):
                config[key] = default
        row = {
            "Id": "a" * 64, "Image": IMAGE,
            "Name": "/" + self.fixtures.project + "-api",
            "Config": config, "HostConfig": request["HostConfig"],
            "Mounts": [],
            "NetworkSettings": {"Networks": {"none": {"NetworkID": "d" * 64}}},
        }
        target = recovery.Target(
            name=self.fixtures.project + "-api", role="api",
            project=self.fixtures.project, service="staging",
            environment="staging", grace_seconds=1,
        )
        binding = {
            "container_id": row["Id"], "image_id": IMAGE,
            "source_commit": SOURCE,
            "configuration_sha256": recovery.fingerprint(row),
        }
        return target, binding, row

    def test_real_cli_fixture_matches_profile_and_previous_bare_option_is_rejected(self):
        corrected = self.capture_fixture_create()
        self.assertEqual(corrected["HostConfig"]["SecurityOpt"], ["no-new-privileges:true"])
        recovery.validate_target(*self.observation(corrected))
        previous = self.capture_fixture_create("no-new-privileges")
        self.assertEqual(previous["HostConfig"]["SecurityOpt"], ["no-new-privileges"])
        with self.assertRaisesRegex(recovery.Refused, "^UNSAFE_RUNTIME_PROFILE$"):
            recovery.validate_target(*self.observation(previous))
        # Client/Engine API negotiation is independent of the spelling contract.
        # A lower negotiated version still exercises the exact fixture request.
        self.server.api_version = "1.44"
        negotiated = self.capture_fixture_create()
        self.assertEqual(negotiated["HostConfig"]["SecurityOpt"], ["no-new-privileges:true"])
        recovery.validate_target(*self.observation(negotiated))


class RecoveryDiagnosticTests(unittest.TestCase):
    def test_only_fixed_refusal_codes_are_reported(self):
        self.assertEqual(
            smoke.diagnostic_code(recovery.Refused("UNSAFE_RUNTIME_PROFILE")),
            "UNSAFE_RUNTIME_PROFILE",
        )
        for error in [
            ValueError("UNRECOGNIZED_UPPERCASE_VALUE"),
            ValueError("UNSAFE_RUNTIME_PROFILE\nsynthetic private response"),
            OSError("synthetic provider credential=redacted"),
            subprocess.CalledProcessError(1, ["docker", "synthetic-private-argument"]),
        ]:
            self.assertEqual(smoke.diagnostic_code(error), "FIXTURE_FAILURE")


if __name__ == "__main__":
    unittest.main()
