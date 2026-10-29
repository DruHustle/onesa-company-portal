"""Synthetic Docker metadata contracts; no provider or release authority."""

import copy
import unittest
from pathlib import Path
from unittest.mock import patch

import oracle_portal as r
import oracle_portal_scanner as scanner
from test_oracle_portal_scanner import inputs


class ImageMetadataTests(unittest.TestCase):
    def verify(self, config_change=lambda value: None):
        binding, _plan = inputs()
        files = {
            "compose.oracle-staging.yaml": "0" * 64,
            scanner.PREFIX + "Dockerfile": "1" * 64,
            **{scanner.PREFIX + name: "2" * 64 for name in scanner.SHIPPED},
        }
        build = {
            **binding,
            "architecture": "arm64",
            "dockerfile_sha256": files[scanner.PREFIX + "Dockerfile"],
        }
        image = {
            "Id": binding["artifact_digest"],
            "Os": "linux",
            "Architecture": "arm64",
            "Config": {
                "User": "clamav",
                "Entrypoint": ["/usr/local/bin/onesa-clamav"],
                "Env": [
                    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
                ],
                "Labels": {
                    "org.opencontainers.image.revision": binding["candidate_commit"],
                    "org.onesa.source-sha256": binding["source_sha256"],
                },
            },
        }
        config_change(image["Config"])

        def digest(path):
            return {
                "source.tar": binding["source_sha256"],
                "build.json": binding["build_sha256"],
                "compose.oracle-staging.yaml": files["compose.oracle-staging.yaml"],
                "scan.json": "3" * 64,
            }[Path(path).name]

        def docker(*arguments):
            if arguments[:2] == ("image", "inspect"):
                return r.canonical([image])
            self.assertIn("sha256sum", arguments)
            return "".join(
                "2" * 64 + "  " + path + "\n" for path in scanner.SHIPPED.values()
            ).encode()

        with (
            patch.object(r, "private", side_effect=lambda path, **kw: Path(path)),
            patch.object(r, "sha", side_effect=digest),
            patch.object(r, "source_inventory", return_value=(None, files)),
            patch.object(
                r,
                "read",
                side_effect=lambda path: (
                    copy.deepcopy(build) if Path(path).name == "build.json" else {}
                ),
            ),
            patch.object(r, "docker", side_effect=docker),
            patch.object(r, "image_security") as security,
        ):
            value = scanner.image(binding, Path("/synthetic/artifact"))
            self.assertEqual(value["image"], binding["artifact_digest"])
            security.assert_called_once_with({}, binding["artifact_digest"])

    def test_omitted_and_explicit_null_default_command_both_mean_no_extra_command(self):
        self.verify()
        self.verify(lambda config: config.update(Cmd=None))

    def test_an_actual_command_or_missing_required_metadata_remains_refused(self):
        for change in [
            lambda config: config.update(Cmd=["unexpected-command"]),
            lambda config: config.update(Cmd=[]),
            lambda config: config.update(User="root", Cmd=None),
            lambda config: config.update(Entrypoint=None, Cmd=None),
            lambda config: config.update(Env=[], Cmd=None),
            lambda config: config.update(Labels={}, Cmd=None),
        ]:
            with self.subTest(change=change), self.assertRaises(r.Refused):
                self.verify(change)


if __name__ == "__main__":
    unittest.main()
