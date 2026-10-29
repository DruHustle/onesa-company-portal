"""Actual Compose interpolation and fail-closed identity custody; no daemon writes."""

import copy
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import oracle_portal as r
import oracle_portal_api as api
import oracle_portal_worker as worker


class RecipeIdentityTests(unittest.TestCase):
    def test_actual_compose_requires_explicit_pinned_identity_and_refuses_changes(self):
        docker = shutil.which("docker")
        self.assertIsNotNone(
            docker, "The actual Compose CLI is a required release test"
        )
        for module, canonical in [
            (api, "/etc/onesa/backends/portal.images.env"),
            (
                worker,
                "/opt/onesa/portal-production/releases/" + "a" * 40 + "/release.env",
            ),
        ]:
            with (
                self.subTest(component=module.__name__),
                tempfile.TemporaryDirectory() as tmp,
            ):
                directory = Path(tmp)
                env = directory / "identity.env"
                identity = "sha256:" + "b" * 64
                env.write_text("PORTAL_IDENTITY_IMAGE=" + identity + "\n")
                env.chmod(0o600)
                recipe = directory / "compose.yaml"
                recipe.write_text(
                    'services:\n  fixture:\n    image: "${PORTAL_IDENTITY_IMAGE:?identity required}"\n'
                )
                plan = {
                    "recipe": {
                        "directory": str(Path(canonical).parent)
                        if module is worker
                        else str(directory),
                        "project": "onesa-identity-fixture",
                        "files": [
                            {
                                "path": str(recipe),
                                "sha256": hashlib.sha256(
                                    recipe.read_bytes()
                                ).hexdigest(),
                            }
                        ],
                        "environment_file": {
                            "path": canonical,
                            "sha256": hashlib.sha256(env.read_bytes()).hexdigest(),
                        },
                    }
                }

                def private(path, canonical=canonical, env=env):
                    self.assertEqual(str(path), canonical)
                    return env

                def pinned(path, digest, recipe=recipe):
                    self.assertEqual(path, recipe)
                    self.assertEqual(
                        hashlib.sha256(path.read_bytes()).hexdigest(), digest
                    )

                with (
                    patch.object(r, "private", side_effect=private),
                    patch.object(r, "pinned_public_file", side_effect=pinned),
                ):
                    command = module.recipe_command(plan)
                    self.assertEqual(command[1:4], ["compose", "--env-file", canonical])
                    # Translate only the two canonical fixture paths for the real CLI.
                    command[0] = docker
                    command[3] = str(env)
                    command[5] = str(directory)
                    clean_env = {"PATH": os.environ["PATH"], "LANG": "C.UTF-8"}
                    result = subprocess.run(
                        command + ["config", "--format", "json"],
                        env=clean_env,
                        capture_output=True,
                        timeout=15,
                        check=False,
                    )
                    self.assertEqual(
                        result.returncode, 0, "Explicit identity did not render"
                    )
                    self.assertEqual(
                        json.loads(result.stdout)["services"]["fixture"]["image"],
                        identity,
                    )
                    negative = subprocess.run(
                        command[:2] + command[4:] + ["config", "--format", "json"],
                        env=clean_env,
                        capture_output=True,
                        timeout=15,
                        check=False,
                    )
                    self.assertNotEqual(
                        negative.returncode,
                        0,
                        "Original omitted-identity command must fail",
                    )
                    env.write_text("PORTAL_IDENTITY_IMAGE=forged\n")
                    with self.assertRaisesRegex(
                        r.Refused, "COMPOSE_IDENTITY_FILE_CHANGED"
                    ):
                        module.recipe_command(plan)
                wrong = copy.deepcopy(plan)
                wrong["recipe"]["environment_file"]["path"] = "/tmp/caller-selected.env"
                with self.assertRaisesRegex(
                    r.Refused, "EXISTING_COMPOSE_IDENTITY_FILE_REQUIRED"
                ):
                    module.identity_file(wrong["recipe"])
