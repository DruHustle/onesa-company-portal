"""Disposable artifact, custody and preservation tests; no hosted acceptance."""

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import oracle_portal as r


class HostedSurfaceTests(unittest.TestCase):
    def observations(self, env, *, portal_ready=200, company_private=403):
        calls = []
        api = r.API_ORIGINS[env]
        frontend = (
            "https://portal.onesa.eu"
            if env == "production"
            else "https://onesa-company-portal-git-staging-synthetic.vercel.app"
        )
        company = "https://onesa.eu"

        def read(origin, path, expected, bypass=None):
            calls.append((origin, path, expected, bypass))
            if env == "production" and origin == company:
                status, body = company_private, None
            elif path == "/api/v1/health":
                status, body = 200, {"status": "ok"}
            elif path == "/api/v1/ready":
                status = portal_ready if origin == frontend else 200
                body = {"status": "ready"}
            elif path == "/api/v1/public/company":
                status, body = 200, {"publication_stage": "prelaunch"}
            else:
                status, body = 401, None
            r.require(status == expected, "SYNTHETIC_HOSTED_STATUS_MISMATCH")
            return body

        observation = {
            "origin": company if env == "production" else frontend,
            "bypass": None if env == "production" else "synthetic-preview-only",
        }
        with patch.object(r, "http_read", side_effect=read):
            result = r.readiness_and_denials({}, env, observation)
        return result, calls, api, frontend

    def test_production_uses_portal_api_and_preserves_company_route_denials(self):
        result, calls, api, frontend = self.observations("production")
        self.assertIn((frontend, "/api/v1/ready", 200, None), calls)
        self.assertIn((api, "/api/v1/ready", 200, None), calls)
        self.assertEqual(result["private_anonymous_denials"], 6)
        self.assertEqual(result["company_surface_denials"], 5)
        self.assertEqual(result["production_mutations"], 0)
        for path in [
            "/api/v1/health",
            "/api/v1/ready",
            "/api/v1/auth/me",
            "/api/v1/admin/content",
            "/api/v1/admin/governance/records",
        ]:
            self.assertIn(("https://onesa.eu", path, 403, None), calls)

    def test_unhealthy_portal_or_exposed_company_routes_still_fail(self):
        for changed in [{"portal_ready": 503}, {"company_private": 200}]:
            with self.subTest(changed=changed), self.assertRaises(r.Refused):
                self.observations("production", **changed)

    def test_staging_keeps_its_exact_preview_origin_and_scoped_bypass(self):
        result, calls, api, frontend = self.observations("staging")
        self.assertEqual(result["company_surface_denials"], 0)
        self.assertEqual(result["private_anonymous_denials"], 6)
        self.assertTrue(
            all(bypass is None for origin, _, _, bypass in calls if origin == api)
        )
        self.assertTrue(
            all(
                bypass == "synthetic-preview-only"
                for origin, _, _, bypass in calls
                if origin == frontend
            )
        )

    def test_partial_deployment_does_not_replace_verified_rollback_reference(self):
        import oracle_portal_frontend as frontend

        retained = {"deployment_id": "dpl-current", "source": "b" * 40}
        rollback = {"deployment_id": "dpl-previous", "source": "a" * 40}
        plan = {
            "project_id": "project",
            "retained_frontend": retained,
            "rollback": {"frontend": rollback},
        }
        actual = {
            "id": "dpl-previous",
            "projectId": "project",
            "readyState": "READY",
            "meta": {"githubCommitSha": "a" * 40},
        }
        with patch.object(frontend, "provider", return_value=actual) as get:
            self.assertEqual(r.verify_rollback_frontend(plan), rollback)
            get.assert_called_once_with("/v13/deployments/dpl-previous")
        for changed in [
            dict(actual, readyState="ERROR"),
            dict(actual, projectId="foreign"),
            dict(actual, meta={"githubCommitSha": "c" * 40}),
        ]:
            with (
                self.subTest(changed=changed),
                patch.object(frontend, "provider", return_value=changed),
                self.assertRaises(r.Refused),
            ):
                r.verify_rollback_frontend(plan)


class ImageEvidenceTests(unittest.TestCase):
    def test_current_exact_image_keeps_same_high_critical_and_secret_gate(self):
        scan = {
            "Metadata": {"ImageID": "fixture"},
            "Results": [{"Vulnerabilities": [{"Severity": "LOW"}]}],
            "ArtifactName": "fixture",
            "CreatedAt": r.now().isoformat(),
        }
        r.image_security(scan, "fixture")
        for changed in [
            dict(scan, Metadata={"ImageID": "wrong"}),
            dict(scan, CreatedAt="2020-01-01T00:00:00Z"),
            dict(scan, Results=[]),
            dict(scan, Results=[{"Vulnerabilities": [{"Severity": "HIGH"}]}]),
            dict(scan, Results=[{"Secrets": [{"RuleID": "synthetic"}]}]),
        ]:
            with self.subTest(changed=changed), self.assertRaises(r.Refused):
                r.image_security(changed, "fixture")


class BackupTransportSourceTests(unittest.TestCase):
    def test_container_copy_preserves_private_install_and_matches_source(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(r, "private") as custody,
        ):
            folder = Path(directory).resolve()
            source = folder / "installed-private.mjs"
            source.write_bytes(b"// public synthetic source only\n")
            source.chmod(0o600)
            pin = r.sha(source)
            copy = r.container_readable_transport(source, pin, folder)
            self.assertEqual(copy.read_bytes(), source.read_bytes())
            self.assertEqual(copy.stat().st_mode & 0o777, 0o444)
            self.assertEqual(source.stat().st_mode & 0o777, 0o600)
            self.assertEqual(folder.stat().st_mode & 0o077, 0)
            custody.assert_called_with(folder, uid=r.os.geteuid(), directory=True)
            with self.assertRaises(FileExistsError):
                r.container_readable_transport(source, pin, folder)

    def test_changed_copy_is_rejected_and_custody_refusal_precedes_write(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory).resolve()
            source = folder / "installed-private.mjs"
            source.write_bytes(b"// synthetic source\n")
            with (
                patch.object(r, "private"),
                self.assertRaisesRegex(r.Refused, "COPY_SOURCE_CHANGED"),
            ):
                r.container_readable_transport(source, "0" * 64, folder)
            (folder / "backup.mjs").unlink()
            with (
                patch.object(r, "private", side_effect=r.Refused("CUSTODY_MODE")),
                self.assertRaises(r.Refused),
            ):
                r.container_readable_transport(source, r.sha(source), folder)
            self.assertFalse((folder / "backup.mjs").exists())

    def test_wrong_path_or_source_pin_is_rejected_before_credentials(self):
        expected = str(Path(r.__file__).resolve().with_name("oracle_backup_store.mjs"))
        for path, pin in [("/tmp/caller-script.mjs", "a" * 64), (expected, "b" * 64)]:
            with (
                self.subTest(path=path, pin=pin),
                patch.object(
                    r,
                    "trusted_toolchain",
                    return_value={
                        "probe_files": {"scripts/oracle_backup_store.mjs": "a" * 64}
                    },
                ),
                patch.object(r, "pinned_public_file") as public_file,
                patch.object(r, "runtime_values") as credentials,
                patch.object(r, "docker") as docker,
                self.assertRaisesRegex(r.Refused, "BACKUP_TRANSPORT_DIFFERS"),
            ):
                r.inspect_database_backup(
                    {},
                    {
                        "legacy_backup": {
                            "transport_path": path,
                            "transport_sha256": pin,
                        }
                    },
                )
            public_file.assert_not_called()
            credentials.assert_not_called()
            docker.assert_not_called()


class OciDescriptorTests(unittest.TestCase):
    def proof(self, value):
        raw = json.dumps(value).encode()
        digest = "sha256:" + hashlib.sha256(raw).hexdigest()
        return digest, {digest: r.base64.b64encode(raw).decode()}

    def test_scanner_config_is_cryptographically_linked_to_actual_manifest(self):
        config = "sha256:" + "a" * 64
        manifest, proof = self.proof(
            {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": {"digest": config},
            }
        )
        self.assertEqual(r.scanned_configuration_digest(manifest, proof), config)
        index, parent = self.proof(
            {
                "schemaVersion": 2,
                "manifests": [
                    {
                        "digest": manifest,
                        "platform": {"os": "linux", "architecture": "arm64"},
                    }
                ],
            }
        )
        self.assertEqual(
            r.scanned_configuration_digest(index, {**proof, **parent}), config
        )
        scan = {
            "Metadata": {"ImageID": config},
            "CreatedAt": r.now().isoformat(),
            "ArtifactName": "fixture",
            "Results": [{}],
        }
        with patch.object(r, "read", return_value=proof):
            r.image_security(scan, manifest)
            with self.assertRaises(r.Refused):
                r.image_security(
                    {**scan, "Metadata": {"ImageID": "sha256:" + "b" * 64}}, manifest
                )

    def test_modified_or_foreign_platform_proof_cannot_relabel_a_scan(self):
        digest, proof = self.proof(
            {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": {"digest": "sha256:" + "a" * 64},
            }
        )
        with self.assertRaises(r.Refused):
            r.scanned_configuration_digest(
                digest, {digest: r.base64.b64encode(b"{}").decode()}
            )
        index, parent = self.proof(
            {
                "schemaVersion": 2,
                "manifests": [
                    {
                        "digest": digest,
                        "platform": {"os": "linux", "architecture": "amd64"},
                    }
                ],
            }
        )
        with self.assertRaises(r.Refused):
            r.scanned_configuration_digest(index, {**parent, **proof})
        self.assertEqual(
            r.scanned_configuration_digest(index, {**parent, **proof}, "amd64"),
            "sha256:" + "a" * 64,
        )
        with self.assertRaises(r.Refused):
            r.scanned_configuration_digest(index, {**parent, **proof}, "ppc64")
        with self.assertRaises(r.Refused):
            r.scanned_configuration_digest(digest, {})


class ProbeCapacityTests(unittest.TestCase):
    def test_probe_fits_existing_one_cpu_daemon_without_expanding_two_cpu_ceiling(self):
        for observed, expected in [(b"1\n", "1"), (b"2\n", "2"), (b"8\n", "2")]:
            with (
                self.subTest(observed=observed),
                patch.object(r, "docker", return_value=observed) as docker,
            ):
                self.assertEqual(r.probe_cpu_limit(), expected)
                docker.assert_called_once_with(
                    "info", "--format", "{{.NCPU}}", timeout=15
                )

    def test_missing_invalid_or_failed_daemon_observation_never_defaults_to_capacity(
        self,
    ):
        for observed in [b"", b"0", b"-1", b"1.5", b"unknown", b"10000"]:
            with (
                self.subTest(observed=observed),
                patch.object(r, "docker", return_value=observed),
                self.assertRaises(r.Refused),
            ):
                r.probe_cpu_limit()
        with (
            patch.object(r, "docker", side_effect=r.Refused("DAEMON_UNAVAILABLE")),
            self.assertRaises(r.Refused),
        ):
            r.probe_cpu_limit()


class FrontendScopeTests(unittest.TestCase):
    def test_copy_change_is_qualified_but_changed_authentication_or_hero_is_not_transferred(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            folder = root / "artifacts"
            folder.mkdir()
            subprocess.run(
                ["git", "init", "--quiet", str(source)], check=True, capture_output=True
            )
            prefix = "onesa-company-portal-frontend/"

            def put(name, body):
                p = source / (prefix + name)
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(body)

            def snapshot(name):
                subprocess.run(
                    ["git", "-C", str(source), "add", "."],
                    check=True,
                    capture_output=True,
                )
                tree = subprocess.check_output(
                    ["git", "-C", str(source), "write-tree"], text=True
                ).strip()
                (folder / name).write_bytes(
                    subprocess.check_output(["git", "-C", str(source), "archive", tree])
                )
                return tree

            put("src/config/products.ts", "original product copy")
            put("src/components/home-products.tsx", "original home products")
            put("src/auth.ts", "unchanged auth boundary")
            put(
                "src/components/responsive-link.tsx",
                "return <Link {...props}>{children}</Link>;",
            )
            old = snapshot("baseline-source.tar")
            plan = {
                "retained_frontend": {
                    "source": "a" * 40,
                    "source_tree": old,
                    "source_sha256": r.sha(folder / "baseline-source.tar"),
                }
            }
            put("src/config/products.ts", "synthetic P-101 description")
            new = snapshot("source.tar")
            with patch.object(r, "private", side_effect=lambda p, **kw: Path(p)):
                result = r.source_equivalence(folder, {"source_tree": new}, plan)
                self.assertEqual(
                    result["changed_frontend_paths"],
                    [prefix + "src/config/products.ts"],
                )
                # A real partial deployment may be current without replacing the
                # independently hash-checked original comparison baseline.
                original = plan["retained_frontend"]
                plan["source_comparison_baseline"] = original
                plan["retained_frontend"] = {
                    "source": "b" * 40,
                    "source_tree": new,
                    "source_sha256": r.sha(folder / "source.tar"),
                }
                repeated = r.source_equivalence(folder, {"source_tree": new}, plan)
                self.assertEqual(repeated, result)
                plan["source_comparison_baseline"] = dict(
                    original, source_sha256="0" * 64
                )
                with self.assertRaisesRegex(
                    r.Refused, "BASELINE_SOURCE_ARCHIVE_CHANGED"
                ):
                    r.source_equivalence(folder, {"source_tree": new}, plan)
                plan["source_comparison_baseline"] = original
                put(
                    "src/components/responsive-link.tsx",
                    "return <Link prefetch={false} {...props}>{children}</Link>;",
                )
                navigation_tree = snapshot("source.tar")
                navigation_result = r.source_equivalence(
                    folder, {"source_tree": navigation_tree}, plan
                )
                self.assertEqual(
                    navigation_result["navigation_change"],
                    "default_speculative_prefetch_disabled_only",
                )
                put(
                    "src/components/responsive-link.tsx",
                    "return <Link prefetch={false} {...props}>unreviewed change</Link>;",
                )
                changed_navigation = snapshot("source.tar")
                with self.assertRaisesRegex(
                    r.Refused, "NAVIGATION_PREFETCH_CHANGE_ONLY"
                ):
                    r.source_equivalence(
                        folder, {"source_tree": changed_navigation}, plan
                    )
                put(
                    "src/components/responsive-link.tsx",
                    "return <Link prefetch={false} {...props}>{children}</Link>;",
                )
                for name in ["src/auth.ts", "src/components/home-hero.tsx"]:
                    put(name, "changed security or hero source")
                    changed = snapshot("source.tar")
                    with (
                        self.subTest(name=name),
                        self.assertRaisesRegex(
                            r.Refused, "REQUIRES_FULL_REQUALIFICATION"
                        ),
                    ):
                        r.source_equivalence(folder, {"source_tree": changed}, plan)
                with self.assertRaisesRegex(r.Refused, "QUALIFIED_GIT_TREE"):
                    r.source_inventory(folder / "source.tar", {"source_tree": new})

    def test_other_component_or_repository_cannot_enter_this_runner(self):
        for repository, component in [
            ("DruHustle/onesa-ai-robot", "frontend"),
            ("DruHustle/onesa-company-portal", "api"),
        ]:
            with (
                self.subTest(component=component),
                self.assertRaisesRegex(r.Refused, "PORTAL_FRONTEND_COMPONENT_SCOPE"),
            ):
                r.component_folder(
                    {
                        "repository": repository,
                        "component": component,
                        "candidate_commit": "a" * 40,
                    }
                )

    def test_changed_retained_service_refuses_acceptance(self):
        names = r.RETAINED_NAMES
        observed = {
            name: {
                "Id": name,
                "RestartCount": 0,
                "State": {
                    "Running": True,
                    "OOMKilled": False,
                    "Health": {"Status": "healthy"},
                },
                "Config": {"Env": ["PUBLICATION_STAGE=prelaunch"]},
            }
            for name in names
        }
        plan = {"retained_services": {name: {"id": name} for name in names}}
        with (
            patch.object(r, "inventory", return_value=observed),
            patch.object(r, "summary", side_effect=lambda row: {"id": row["Id"]}),
        ):
            r.retained_services(plan)
            observed[next(iter(names))]["Id"] = "unreviewed-container"
            with self.assertRaisesRegex(r.Refused, "RETAINED_SERVICE_CHANGED"):
                r.retained_services(plan)

    def test_browser_timeout_removes_only_owned_temporary_request(self):
        import oracle_portal_frontend as frontend

        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "observations").mkdir()
            with (
                patch.object(r, "inventory", return_value={}),
                patch.object(r, "retained_services", return_value={}),
                patch.object(
                    frontend,
                    "observe_provider",
                    return_value={
                        "origin": "https://fixture.invalid",
                        "bypass": "synthetic-bypass",
                    },
                ),
                patch.object(r, "readiness_and_denials", return_value={}),
                patch.object(r, "probe_cpu_limit", return_value="1"),
                patch.object(
                    r.subprocess,
                    "run",
                    side_effect=subprocess.TimeoutExpired("probe", 1),
                ),
                self.assertRaises(subprocess.TimeoutExpired),
            ):
                r.probe(
                    {"component": "frontend"},
                    "staging",
                    "owned-operation",
                    folder,
                    {"probe_image": "sha256:" + "a" * 64},
                )
            output = folder / "observations/owned-operation"
            self.assertFalse((output / "browser-request.json").exists())
            self.assertTrue((output / "browser.stderr").exists())
            self.assertFalse((output / "receipt.json").exists())


class CredentialFreeBuildTests(unittest.TestCase):
    def test_secret_or_wrong_target_configuration_is_rejected_before_candidate_execution(
        self,
    ):
        import oracle_frontend_build as builder

        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            folder.chmod(0o700)
            (folder / "source.tar").write_bytes(b"disposable-source-fixture")
            binding = {"source_sha256": r.sha(folder / "source.tar")}
            settings = {
                "framework": "nextjs",
                "rootDirectory": "onesa-company-portal-frontend",
                "nodeVersion": "24.x",
                "buildCommand": None,
                "installCommand": None,
                "outputDirectory": None,
            }
            base = {
                "projectId": "prj_fixture",
                "orgId": "team_fixture",
                "projectName": "fixture",
                "settings": settings,
                "public_environment": {
                    "BACKEND_URL": r.API_ORIGINS["staging"],
                    "SITE_URL": "https://onesa.eu",
                    "PUBLIC_RELEASE_ENABLED": "false",
                },
            }
            import copy

            for changes in [
                {"PROXY_SHARED_KEY": "must-never-enter-build"},
                {"BACKEND_URL": r.API_ORIGINS["production"]},
                {"PUBLIC_RELEASE_ENABLED": "true"},
                {"PUBLIC_ORIGIN": "https://portal.onesa.eu"},
            ]:
                metadata = copy.deepcopy(base)
                metadata["public_environment"].update(changes)
                with (
                    self.subTest(keys=list(changes)),
                    patch.object(r, "source_inventory"),
                    patch.object(builder.subprocess, "run") as run,
                    self.assertRaises(r.Refused),
                ):
                    builder.build(
                        folder,
                        binding,
                        metadata,
                        "sha256:" + "a" * 64,
                        environment="staging",
                    )
                run.assert_not_called()
