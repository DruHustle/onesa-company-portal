"""Clean locked installation from the Oracle probe's actual COPY inputs.

Run after the ordinary frontend ``npm ci`` has populated the public package cache.
This uses no provider, credentials, application server, or Docker daemon. It tests
the recipe's dependency closure; the actual scanned ARM64 image remains a separate
release prerequisite.
"""

import base64
import hashlib
import importlib.util
import json
import os
import shlex
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = "onesa-company-portal-frontend"
RECIPE = ROOT / "infra/oracle/qualification.Dockerfile"


def context_inputs(recipe, target, *, before_install=False):
    """Materialize this recipe's context COPYs, excluding base-image files."""
    workdir = None
    found_install = False
    for line in recipe.splitlines():
        words = shlex.split(line, comments=True)
        if not words:
            continue
        if words[0] == "WORKDIR":
            if words != ["WORKDIR", "/opt/onesa-company-portal"]:
                raise AssertionError("Unexpected Oracle probe working directory")
            workdir = target
        if words[0] == "RUN" and "ci" in words:
            if workdir is None or words[1:7] != [
                "node", "/tmp/npm/bin/npm-cli.js", "ci", "--ignore-scripts",
                "--prefix", FRONTEND,
            ]:
                raise AssertionError("Oracle probe locked installation changed")
            found_install = True
            if before_install:
                return target / FRONTEND
        if words[0] != "COPY" or words[1].startswith("--from="):
            continue
        if workdir is None or len(words) < 3:
            raise AssertionError("Unexpected Oracle probe COPY scope")
        names = [PurePosixPath(name) for name in words[1:]]
        if any(name.is_absolute() or ".." in name.parts for name in names):
            raise AssertionError("Dependency input COPY escapes its context")
        destination = target / names[-1]
        for source_name in names[:-1]:
            source = ROOT / source_name
            if source.is_symlink():
                raise AssertionError("Dependency input cannot be a link")
            if source.is_dir():
                shutil.copytree(source, destination, dirs_exist_ok=True)
            else:
                path = (
                    destination / source.name
                    if words[-1].endswith("/") or len(names) > 2
                    else destination
                )
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, path)
    if not found_install:
        raise AssertionError("Oracle probe locked installation missing")
    return target / FRONTEND


def install_inputs(recipe, target):
    return context_inputs(recipe, target, before_install=True)


def validate_local_archives(frontend):
    lock = json.loads((frontend / "package-lock.json").read_text())
    local = {
        value["resolved"]: value["integrity"]
        for value in lock["packages"].values()
        if value.get("resolved", "").startswith("file:")
    }
    if not local:
        raise AssertionError("Expected the reviewed local dependency")
    for resolved, integrity in local.items():
        relative = PurePosixPath(resolved.removeprefix("file:"))
        if relative.is_absolute() or ".." in relative.parts:
            raise AssertionError("Local dependency escapes the frontend")
        archive = frontend / relative
        if not archive.is_file() or archive.is_symlink():
            raise AssertionError("Missing locked local dependency archive")
        actual = "sha512-" + base64.b64encode(
            hashlib.sha512(archive.read_bytes()).digest()
        ).decode("ascii")
        if actual != integrity:
            raise AssertionError("Local dependency differs from lockfile integrity")
    return local


class OracleProbeDependencyTests(unittest.TestCase):
    def test_image_context_contains_all_commissioned_probe_source_pins(self):
        spec = importlib.util.spec_from_file_location(
            "oracle_probe_packaging_runner", ROOT / "scripts/release/oracle_portal.py"
        )
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        with tempfile.TemporaryDirectory(prefix="onesa-probe-context-") as name:
            target = Path(name)
            context_inputs(RECIPE.read_text(), target)
            files = {
                str(path.relative_to(target)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in target.rglob("*") if path.is_file()
            }
            for profile in (runner.PRESENTATION_PROFILE, runner.NVIDIA_PROFILE):
                with self.subTest(profile=profile):
                    pins = runner.probe_source_files(files, profile)
                    self.assertEqual(pins, {
                        path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest()
                        for path in pins
                    })

    def test_omitted_or_changed_local_archive_cannot_pass_input_validation(self):
        recipe = RECIPE.read_text()
        original = "\n".join(
            line for line in recipe.splitlines()
            if not (line.startswith("COPY ") and FRONTEND + "/vendor " in line)
        )
        with tempfile.TemporaryDirectory(prefix="onesa-probe-missing-") as name:
            frontend = install_inputs(original, Path(name))
            with self.assertRaisesRegex(AssertionError, "Missing locked local"):
                validate_local_archives(frontend)
        with tempfile.TemporaryDirectory(prefix="onesa-probe-changed-") as name:
            frontend = install_inputs(recipe, Path(name))
            local = validate_local_archives(frontend)
            for resolved in local:
                archive = frontend / resolved.removeprefix("file:")
                archive.write_bytes(archive.read_bytes() + b"changed fixture")
            with self.assertRaisesRegex(AssertionError, "lockfile integrity"):
                validate_local_archives(frontend)

    def test_actual_recipe_inputs_support_clean_offline_locked_installation(self):
        npm = shutil.which("npm")
        node = shutil.which("node")
        self.assertIsNotNone(npm, "Node 24/npm and a warmed frontend cache are required")
        self.assertIsNotNone(node)
        cache = subprocess.run(
            [npm, "config", "get", "cache"], check=True, capture_output=True,
            text=True, timeout=15,
        ).stdout.strip()
        self.assertTrue(Path(cache).is_absolute())
        with tempfile.TemporaryDirectory(prefix="onesa-probe-install-") as name:
            target = Path(name)
            frontend = install_inputs(RECIPE.read_text(), target)
            validate_local_archives(frontend)
            before = (frontend / "package-lock.json").read_bytes()
            configuration = target / "empty.npmrc"
            configuration.write_text("")
            global_configuration = target / "global.npmrc"
            global_configuration.write_text("")
            environment = {
                "PATH": os.environ["PATH"],
                "LANG": "C.UTF-8",
                "npm_config_cache": cache,
                "npm_config_userconfig": str(configuration),
                "npm_config_globalconfig": str(global_configuration),
                "npm_config_logs_max": "0",
                "npm_config_update_notifier": "false",
            }
            result = subprocess.run(
                [npm, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
                cwd=frontend, env=environment, capture_output=True, text=True,
                timeout=180, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr[-12000:])
            self.assertEqual((frontend / "package-lock.json").read_bytes(), before)
            result = subprocess.run(
                [node, "-e", r"""
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const lock = require('./package-lock.json');
assert.match(process.versions.node, /^24\./);
assert.equal(require('playwright/package.json').version,
             lock.packages['node_modules/playwright'].version);
for (const engine of ['chromium', 'firefox', 'webkit'])
  assert.equal(typeof require('playwright')[engine].launch, 'function');
const fromESLint = createRequire(require.resolve('eslint/package.json'));
const adapter = fromESLint('minimatch');
assert.equal(typeof adapter, 'function');
assert.equal(adapter('fixture/example.ts', 'fixture/**/*.ts'), true);
assert.equal(adapter('fixture/example.js', 'fixture/**/*.ts'), false);
assert.equal(fromESLint('minimatch/package.json').name,
             '@onesa/portal-minimatch-callable');
"""],
                cwd=frontend, env=environment, capture_output=True, text=True,
                timeout=15, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr[-12000:])


if __name__ == "__main__":
    unittest.main()
