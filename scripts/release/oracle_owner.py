"""Owner-run Oracle evidence bridge. Install a reviewed immutable copy outside Git.

This command never accepts a caller's PASS or an Actions run as owner authority.
The commissioned root store signs records with its separate Ed25519 key. Pinned
owner-installed runners perform observations and provider operations. The command
reserves contexts and deployment intents durably before executing those runners.
"""

import argparse
import base64
import hashlib
import json
import os
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID, uuid4

OWNER = "DruHustle"
POLICIES = {
    "onesa-company-portal": (
        "verify.yml",
        [
            "verify",
            "pipeline-security / workflow-security",
            "ci-summary",
            "image-security (onesa-company-portal-backend)",
            "image-security (onesa-company-portal-frontend)",
        ],
    ),
    "onesa-ai-platform": (
        "ci.yml",
        [
            "backend",
            "frontend",
            "browser",
            "documentation",
            "containers",
            "tls-acceptance",
            "pipeline-security / workflow-security",
            "ci-summary",
            "image-security (onesa-ai-platform-backend)",
            "image-security (onesa-ai-platform-frontend)",
        ],
    ),
    "onesa-ai-robot": (
        "scaffold.yml",
        [
            "backend",
            "frontend",
            "containers (frontend)",
            "containers (backend)",
            "pipeline-security / workflow-security",
            "ci-summary",
        ],
    ),
}
PHASES = ("staging", "operations", "deploy", "production")
REQUIRED_CHECKS = {
    "staging": {
        "source_build_image_identity",
        "configuration_and_isolation",
        "authentication_and_authorization",
        "persistence",
        "affected_workflows",
        "schema_and_migrations",
        "rollback_readiness",
        "security_and_contracts",
    },
    "operations": {
        "backup_restore",
        "monitoring_and_capacity",
        "privacy_publication_controls",
        "preservation_baseline",
        "rollback_readiness",
    },
    "deploy": {
        "exact_authorized_artifact",
        "configuration_preserved",
        "independent_components_preserved",
        "provider_receipt",
    },
    "production": {
        "source_build_image_identity",
        "health_readiness",
        "authentication_and_authorization",
        "affected_workflows",
        "persistence_preserved",
        "independent_components_preserved",
        "configuration_preserved",
        "no_unapproved_processing_or_actuation",
    },
}
HEX = re.compile(r"[a-f0-9]{64}")
OPENSSL = "/usr/bin/openssl" if sys.platform == "linux" else "/opt/homebrew/bin/openssl"
ANCHOR = Path("/etc/onesa/oracle-release-trust.json")


class Rejected(ValueError):
    pass


def require(value, reason):
    if not value:
        raise Rejected(reason)


def canonical(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def file_digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def timestamp():
    return datetime.now(timezone.utc)


def identifier(value):
    require(
        isinstance(value, str) and str(UUID(value)) == value,
        "Canonical record UUID required",
    )
    return value


def private(path, *, directory=False, uid=0):
    path = Path(path)
    require(
        path.is_absolute() and not any(p.is_symlink() for p in [path, *path.parents]),
        "Custody path alias",
    )
    s = path.stat()
    require(
        s.st_uid == uid and s.st_mode & 0o077 == 0, "Private owner custody required"
    )
    require(
        stat.S_ISDIR(s.st_mode)
        if directory
        else stat.S_ISREG(s.st_mode) and s.st_nlink == 1,
        "Custody file type",
    )
    if uid == 0:
        require(
            all(
                p.stat().st_uid == 0 and p.stat().st_mode & 0o022 == 0
                for p in path.parents
            ),
            "Production custody ancestors must be root-owned and non-writable",
        )


def signed_bytes(key, public, payload=None, signature=None):
    """OpenSSL Ed25519; key material is never returned or passed on the command line."""
    with tempfile.TemporaryDirectory(prefix=".signature-", dir=public.parent) as folder:
        folder = Path(folder)
        source, sig = folder / "record", folder / "signature"
        source.write_bytes(payload)
        source.chmod(0o600)
        if signature is None:
            args = [OPENSSL, "pkeyutl", "-sign", "-rawin", "-inkey", str(key)]
        else:
            sig.write_bytes(signature)
            sig.chmod(0o600)
            args = [
                OPENSSL,
                "pkeyutl",
                "-verify",
                "-rawin",
                "-pubin",
                "-inkey",
                str(public),
                "-sigfile",
                str(sig),
            ]
        r = subprocess.run(
            [*args, "-in", str(source)], capture_output=True, timeout=15, check=False
        )
        require(r.returncode == 0, "Record signature invalid or unavailable")
        return r.stdout


class GitHub:
    def __init__(self, token):
        require(
            isinstance(token, str) and token and "\n" not in token,
            "Existing owner token required in private stdin",
        )
        self.token = token

    def api(self, path):
        require(
            path == "user" or path.startswith("repos/" + OWNER + "/"),
            "Foreign GitHub path",
        )
        request = urllib.request.Request(
            "https://api.github.com/" + path,
            headers={
                "Authorization": "Bearer " + self.token,
                "Accept": "application/vnd.github+json",
                "User-Agent": "OnesaOracleOwnerBridge/1",
            },
        )

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None

        with urllib.request.build_opener(NoRedirect()).open(
            request, timeout=25
        ) as response:
            raw = response.read(8 * 1024 * 1024 + 1)
        require(len(raw) <= 8 * 1024 * 1024, "GitHub response bound")
        return json.loads(raw)

    def owner(self):
        require(not os.getenv("GITHUB_ACTIONS"), "Owner custody cannot run in Actions")
        require(
            self.api("user").get("login") == OWNER,
            "Current authenticated owner required",
        )
        return OWNER

    def qualify(self, binding):
        repo, sha = binding["repository"], binding["candidate_commit"]
        prefix = "repos/" + repo + "/"
        require(
            self.api(prefix + "branches/main")["commit"]["sha"] == sha,
            "Current exact main required",
        )
        require(
            self.api(prefix + "git/commits/" + sha)["tree"]["sha"]
            == binding["source_tree"],
            "Source tree differs from qualified commit",
        )
        prs = self.api(prefix + "commits/" + sha + "/pulls?per_page=100")
        require(
            any(
                p.get("merged_at")
                and p.get("merge_commit_sha") == sha
                and p.get("base", {}).get("ref") == "main"
                and p.get("merged_by", {}).get("login") == OWNER
                for p in [self.api(prefix + "pulls/" + str(x["number"])) for x in prs]
            ),
            "Owner-merged main PR required",
        )
        workflow, jobs = POLICIES[repo.split("/")[1]]
        references = []
        for name, required in [
            (workflow, jobs),
            ("repository-hygiene.yml", ["publication-hygiene"]),
        ]:
            runs = self.api(
                prefix
                + "actions/workflows/"
                + name
                + "/runs?head_sha="
                + sha
                + "&per_page=100"
            )["workflow_runs"]
            runs = sorted(
                [
                    r
                    for r in runs
                    if r["event"] == "push" and r["head_branch"] == "main"
                ],
                key=lambda r: r["id"],
                reverse=True,
            )
            require(runs, "Exact-main CI missing")
            run = self.api(prefix + "actions/runs/" + str(runs[0]["id"]))
            require(
                run["repository"]["full_name"] == repo
                and run["head_repository"]["full_name"] == repo
                and run["head_sha"] == sha
                and run["head_branch"] == "main"
                and run["event"] == "push"
                and run["path"] == ".github/workflows/" + name
                and run["run_attempt"] == 1
                and run["status"] == "completed"
                and run["conclusion"] == "success",
                "Exact-main first-attempt CI failed or incomplete",
            )
            require(
                timedelta(0)
                <= timestamp() - datetime.fromisoformat(run["updated_at"])
                < timedelta(hours=24),
                "Exact-main CI evidence expired",
            )
            result = self.api(
                prefix
                + "actions/runs/"
                + str(run["id"])
                + "/jobs?filter=latest&per_page=100"
            )
            require(
                result["total_count"] <= 100,
                "CI job pagination requires explicit review",
            )
            by_name = {j["name"]: j for j in result["jobs"]}
            for job in required:
                require(
                    job in by_name
                    and by_name[job]["status"] == "completed"
                    and by_name[job]["conclusion"] == "success",
                    "Mandatory CI job failed/skipped/missing",
                )
                require(
                    all(
                        s["conclusion"] == "success"
                        for s in by_name[job].get("steps", [])
                        if s["name"].startswith("Release requirement:")
                    ),
                    "Mandatory CI step failed/skipped",
                )
            artifacts = self.api(
                prefix + "actions/runs/" + str(run["id"]) + "/artifacts?per_page=100"
            )
            require(
                artifacts["total_count"] <= 100,
                "CI artifact pagination requires explicit review",
            )
            manifests = [
                {k: a[k] for k in ["id", "name", "digest"]}
                for a in artifacts["artifacts"]
                if a["name"].startswith("runtime-")
                and not a["expired"]
                and re.fullmatch(r"sha256:[a-f0-9]{64}", a.get("digest", ""))
            ]
            if name == workflow:
                require(
                    {
                        "runtime-" + repo.split("/")[1] + "-" + x
                        for x in ["backend", "frontend"]
                    }
                    <= {a["name"] for a in manifests},
                    "Genuine tested image manifests required",
                )
            references.append(
                {
                    "run_id": run["id"],
                    "workflow": name,
                    "candidate_commit": sha,
                    "run_attempt": 1,
                    "artifacts": manifests,
                }
            )
        return references


def binding_valid(value, policy):
    fields = {
        "repository",
        "component",
        "candidate_commit",
        "source_tree",
        "source_sha256",
        "build_sha256",
        "artifact_digest",
        "configuration_sha256",
        "target_environment",
    }
    require(
        isinstance(value, dict) and set(value) == fields,
        "Complete exact component binding required",
    )
    require(
        value["repository"] in {OWNER + "/" + r for r in POLICIES}
        and value["target_environment"] == "production",
        "Repository/target scope refused",
    )
    require(
        re.fullmatch(r"[a-f0-9]{40}", value["candidate_commit"])
        and re.fullmatch(r"[a-f0-9]{40}", value["source_tree"]),
        "Exact source identity required",
    )
    require(
        all(HEX.fullmatch(value[k]) for k in ["source_sha256", "build_sha256"]),
        "Source/build digest required",
    )
    require(
        re.fullmatch(r"sha256:[a-f0-9]{64}", value["artifact_digest"]),
        "Immutable artifact digest required",
    )
    require(
        set(value["configuration_sha256"]) == {"staging", "production"}
        and all(HEX.fullmatch(x) for x in value["configuration_sha256"].values()),
        "Separate configuration bindings required",
    )
    profile = policy["components"].get(value["repository"] + ":" + value["component"])
    require(
        profile and set(profile["runners"]) == set(PHASES),
        "Component is not commissioned",
    )
    require(
        isinstance(profile.get("qualification_attempt_limit"), int)
        and 1 <= profile["qualification_attempt_limit"] <= 100,
        "Explicit finite owner qualification allowance required",
    )
    require(
        all(profile["required_checks"].get(p) for p in PHASES),
        "Complete qualification policy required",
    )
    for phase in PHASES:
        checks, runner = profile["required_checks"][phase], profile["runners"][phase]
        require(
            isinstance(checks, list)
            and len(checks) == len(set(checks))
            and REQUIRED_CHECKS[phase] <= set(checks),
            "Mandatory release checks cannot be removed",
        )
        require(
            HEX.fullmatch(runner["sha256"]) and 1 <= runner["timeout_seconds"] <= 3600,
            "Pinned bounded runner required",
        )
    return profile


def commissioned(registry, root, trust):
    anchor = registry.get("installations", {}).get(str(root))
    require(
        registry.get("schema_version") == 1
        and anchor
        and anchor.get("active") is True
        and all(
            anchor.get(k) == trust[k]
            for k in ["installation_id", "key_id", "verifier_sha256", "policy_sha256"]
        ),
        "Installation has not been explicitly commissioned",
    )


class Store:
    def __init__(self, root, github, *, uid=0, clock=timestamp):
        self.root, self.github, self.clock = Path(root), github, clock
        private(self.root, directory=True, uid=uid)
        for name in [
            "trust.json",
            "policy.json",
            "signing.pem",
            "public.pem",
            "records.sqlite",
        ]:
            private(self.root / name, uid=uid)
        self.trust = json.loads((self.root / "trust.json").read_text())
        require(
            self.trust["verifier_sha256"] == file_digest(__file__)
            and self.trust["policy_sha256"] == file_digest(self.root / "policy.json")
            and self.trust["key_id"] == file_digest(self.root / "public.pem")
            and self.trust["openssl_sha256"] == file_digest(OPENSSL),
            "Commissioned verifier/policy/key pin changed",
        )
        self.policy = json.loads((self.root / "policy.json").read_text())
        if uid == 0:
            private(ANCHOR)
            commissioned(json.loads(ANCHOR.read_text()), self.root, self.trust)
        self.db = sqlite3.connect(
            self.root / "records.sqlite", timeout=20, isolation_level=None
        )
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA synchronous=FULL")
        self.github.owner()

    @contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def put(self, kind, binding, details, *, parent=None, ttl=3600):
        require(60 <= ttl <= 86400, "Bounded record lifetime required")
        record = {
            "schema_version": 1,
            "id": str(uuid4()),
            "kind": kind,
            "binding": binding,
            "workflow_run_id": 0,
            "execution_context": "owner-operated-oracle-staging"
            if kind in ["context", "qualification"]
            else "owner-operated-oracle-release",
            "issued_at": self.clock().isoformat(),
            "expires_at": (self.clock() + timedelta(seconds=ttl)).isoformat(),
            "parent": parent,
            "owner_provenance": {
                "mechanism": "commissioned-pinned-OpenSSH-and-authenticated-owner",
                "owner": OWNER,
                "installation_id": self.trust["installation_id"],
                "verifier_sha256": self.trust["verifier_sha256"],
            },
            "details": details,
        }
        signature = signed_bytes(
            self.root / "signing.pem", self.root / "public.pem", canonical(record)
        )
        envelope = {
            "record": record,
            "signature": {
                "algorithm": "Ed25519",
                "key_id": self.trust["key_id"],
                "value": base64.b64encode(signature).decode(),
            },
        }
        self.db.execute(
            "INSERT INTO records(id,kind,scope,envelope,parent,created) VALUES(?,?,?,?,?,?)",
            (
                record["id"],
                kind,
                binding["repository"] + ":" + binding["component"],
                canonical(envelope).decode(),
                parent,
                record["issued_at"],
            ),
        )
        return envelope

    def get(self, id_, kind=None, binding=None, *, historical=False):
        identifier(id_)
        row = self.db.execute(
            "SELECT envelope,revoked,parent,kind,scope,created FROM records WHERE id=?",
            (id_,),
        ).fetchone()
        require(
            row is not None and (historical or not row[1]), "Record missing/revoked"
        )
        envelope = json.loads(row[0])
        r, s = envelope["record"], envelope["signature"]
        require(
            s["algorithm"] == "Ed25519" and s["key_id"] == self.trust["key_id"],
            "Foreign signer",
        )
        signed_bytes(
            None,
            self.root / "public.pem",
            canonical(r),
            base64.b64decode(s["value"], validate=True),
        )
        require(
            r["schema_version"] == 1
            and r["id"] == id_
            and r["kind"] == row[3]
            and r["parent"] == row[2]
            and r["issued_at"] == row[5]
            and r["binding"]["repository"] + ":" + r["binding"]["component"] == row[4],
            "Signed record and custody index differ",
        )
        issued, expiry = (
            datetime.fromisoformat(r["issued_at"]),
            datetime.fromisoformat(r["expires_at"]),
        )
        require(
            expiry - issued <= timedelta(hours=24)
            and (historical or issued <= self.clock() < expiry),
            "Record expired/not yet valid",
        )
        require(
            r["workflow_run_id"] == 0
            and r["owner_provenance"]["installation_id"]
            == self.trust["installation_id"]
            and r["owner_provenance"]["verifier_sha256"]
            == self.trust["verifier_sha256"]
            and r["owner_provenance"]["owner"] == OWNER
            and r["owner_provenance"]["mechanism"]
            == "commissioned-pinned-OpenSSH-and-authenticated-owner",
            "Owner-run provenance missing",
        )
        require(
            (kind is None or r["kind"] == kind)
            and (binding is None or r["binding"] == binding),
            "Wrong record kind/source/component/environment/artifact",
        )
        binding_valid(r["binding"], self.policy)
        if row[2]:
            self.get(row[2], binding=r["binding"], historical=historical)
        if r["kind"] == "authorization":
            require(
                r["details"]["decision"] == "approve"
                and r["details"]["physical_hardware_authorized"] is False,
                "Scoped software authorization required",
            )
            self.get(
                r["details"]["attempt_id"],
                "authorization-attempt",
                r["binding"],
                historical=historical,
            )
        return envelope

    def runner(self, phase, binding, context):
        profile = binding_valid(binding, self.policy)
        runner = profile["runners"][phase]
        path = Path(runner["path"])
        private(path, uid=self.root.stat().st_uid)
        require(
            path.resolve().is_relative_to(Path(self.trust["runner_root"]))
            and file_digest(path) == runner["sha256"],
            "Unreviewed runner refused",
        )
        r = subprocess.run(
            ["/usr/bin/python3", "-I", str(path), phase],
            input=canonical({"binding": binding, "context": context}),
            capture_output=True,
            timeout=runner["timeout_seconds"],
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            check=False,
        )
        require(
            r.returncode == 0 and len(r.stdout) <= 1024 * 1024,
            "Pinned runner failed/interrupted; inspect only",
        )
        value = json.loads(r.stdout)
        require(
            value.get("binding") == binding
            and value.get("environment")
            == ("staging" if phase == "staging" else "production"),
            "Observed source/artifact/environment mismatch",
        )
        require(
            value.get("workflow_run_id") == 0,
            "Owner observation must retain run ID zero",
        )
        if phase in ["deploy", "production"]:
            require(
                value.get("operation_id") == context["operation_id"],
                "Provider observation belongs to another operation",
            )
        require(
            isinstance(value.get("checks"), dict)
            and all(
                value["checks"].get(k) == "PASS"
                for k in profile["required_checks"][phase]
            ),
            "Mandatory observed check missing/failed/skipped",
        )
        require(
            value.get("observed_at")
            and timedelta(0)
            <= self.clock() - datetime.fromisoformat(value["observed_at"])
            < timedelta(minutes=5),
            "Fresh observations required",
        )
        return {"runner_sha256": runner["sha256"], "observations": value}

    def issue_context(self, binding):
        profile = binding_valid(binding, self.policy)
        ci = self.github.qualify(binding)
        with self.transaction():
            previous = self.db.execute(
                "SELECT envelope FROM records WHERE kind='context' AND scope=?",
                (binding["repository"] + ":" + binding["component"],),
            ).fetchall()
            count = sum(
                json.loads(row[0])["record"]["binding"]["candidate_commit"]
                == binding["candidate_commit"]
                for row in previous
            )
            require(
                count < profile["qualification_attempt_limit"],
                "Source-specific qualification allowance exhausted; no implicit renewal",
            )
            result = self.put(
                "context",
                binding,
                {
                    "ci": ci,
                    "state": "ISSUED_UNUSED",
                    "qualification_environment": "staging",
                },
            )
            self.db.execute(
                "INSERT INTO contexts(id,state) VALUES(?,?)",
                (result["record"]["id"], "issued"),
            )
        return result

    def qualify(self, context):
        r = self.get(context, "context")["record"]
        binding = r["binding"]
        with self.transaction():
            self.get(context, "context", binding)
            changed = self.db.execute(
                "UPDATE contexts SET state='reserved' WHERE id=? AND state='issued'",
                (context,),
            ).rowcount
            require(
                changed == 1, "Context already reserved/consumed; no automatic retry"
            )
        # Reservation commits before the first hosted request, including failures.
        ci = self.github.qualify(binding)
        stage = self.runner("staging", binding, {"context_id": context})
        operations = self.runner("operations", binding, {"context_id": context})
        with self.transaction():
            self.get(context, "context", binding)
            result = self.put(
                "qualification",
                binding,
                {"ci": ci, "staging": stage, "operations": operations},
                parent=context,
            )
            self.db.execute(
                "UPDATE contexts SET state='consumed' WHERE id=? AND state='reserved'",
                (context,),
            )
        return result

    def authorize(self, qualification):
        r = self.get(qualification, "qualification")["record"]
        binding = r["binding"]
        with self.transaction():
            attempt = self.put(
                "authorization-attempt",
                binding,
                {"decision": "PENDING"},
                parent=qualification,
            )
        ci = self.github.qualify(binding)
        operations = self.runner(
            "operations",
            binding,
            {"qualification_id": qualification, "owner_decision": "approve"},
        )
        # Owner invocation is a signed decision, never a caller's JSON approval.
        with self.transaction():
            self.get(qualification, "qualification", binding)
            return self.put(
                "authorization",
                binding,
                {
                    "decision": "approve",
                    "ci": ci,
                    "operations": operations,
                    "attempt_id": attempt["record"]["id"],
                    "physical_hardware_authorized": False,
                },
                parent=qualification,
            )

    def deploy(self, authorization):
        r = self.get(authorization, "authorization")["record"]
        binding = r["binding"]
        existing = self.db.execute(
            "SELECT id,state FROM deployments WHERE authorization=?", (authorization,)
        ).fetchone()
        if existing:
            return {
                "operation_id": existing[0],
                "state": existing[1],
                "action": "INSPECT_ONLY_NO_DUPLICATE_REQUEST",
            }
        self.github.qualify(binding)
        self.runner(
            "operations",
            binding,
            {"authorization_id": authorization, "before_deployment": True},
        )
        scope = binding["repository"] + ":" + binding["component"]
        with self.transaction():
            self.get(authorization, "authorization", binding)
            latest = self.db.execute(
                "SELECT id FROM records WHERE scope=? AND kind='authorization-attempt' ORDER BY sequence DESC LIMIT 1",
                (scope,),
            ).fetchone()
            require(
                latest and latest[0] == r["details"]["attempt_id"],
                "Authorization superseded by a newer owner decision",
            )
            operation = self.put(
                "deployment-intent",
                binding,
                {
                    "authorization": authorization,
                    "provider_request_budget": 1,
                    "automatic_retry": False,
                },
                parent=authorization,
            )
            id_ = operation["record"]["id"]
            try:
                self.db.execute(
                    "INSERT INTO deployments(id,authorization,state) VALUES(?,?,'request-recorded')",
                    (id_, authorization),
                )
            except sqlite3.IntegrityError:
                raise Rejected("Concurrent deployment reserved; inspect only") from None
        receipt = self.runner(
            "deploy", binding, {"operation_id": id_, "authorization_id": authorization}
        )
        require(
            isinstance(receipt["observations"].get("deployment_id"), str)
            and receipt["observations"]["deployment_id"],
            "Provider receipt missing; inspect existing operation",
        )
        with self.transaction():
            self.put("deployment-receipt", binding, receipt, parent=id_)
            self.db.execute(
                "UPDATE deployments SET state='deployed-unverified' WHERE id=?", (id_,)
            )
        return self.inspect(id_, observe=True)

    def inspect(self, operation, *, observe=False):
        r = self.get(operation, "deployment-intent", historical=True)["record"]
        row = self.db.execute(
            "SELECT state FROM deployments WHERE id=?", (operation,)
        ).fetchone()
        require(row, "Deployment operation missing")
        if not observe:
            return {
                "operation_id": operation,
                "state": row[0],
                "provider_write": False,
                "intent": r,
            }
        observed = self.runner(
            "production", r["binding"], {"operation_id": operation, "read_only": True}
        )
        require(
            observed["observations"].get("deployment_id"),
            "Actual running deployment identity required",
        )
        receipts = self.db.execute(
            "SELECT id FROM records WHERE kind='deployment-receipt' AND parent=?",
            (operation,),
        ).fetchall()
        if receipts:
            receipt = self.get(receipts[-1][0], historical=True)["record"]["details"]
            require(
                observed["observations"]["deployment_id"]
                == receipt["observations"]["deployment_id"],
                "Canonical deployment differs from provider receipt",
            )
        with self.transaction():
            result = self.put(
                "production-verification", r["binding"], observed, parent=operation
            )
            self.db.execute(
                "UPDATE deployments SET state='accepted' WHERE id=?", (operation,)
            )
        return result

    def revoke(self, record):
        r = self.get(record, historical=True)["record"]
        with self.transaction():
            result = self.put("revocation", r["binding"], {"revoked_id": record})
            self.db.execute("UPDATE records SET revoked=1 WHERE id=?", (record,))
        return result


def bootstrap(root, policy, source_pin, policy_pin, runner_root, principal):
    require(
        os.geteuid() == 0 and not os.getenv("GITHUB_ACTIONS"),
        "Explicit external root-owner bootstrap required",
    )
    require(
        HEX.fullmatch(source_pin)
        and file_digest(__file__) == source_pin
        and HEX.fullmatch(policy_pin)
        and file_digest(policy) == policy_pin,
        "Owner-reviewed installation pins required",
    )
    private(Path(__file__))
    private(policy)
    private(runner_root, directory=True)
    require(
        principal.startswith("SHA256:") and len(principal) > 20,
        "Pinned owner SSH principal fingerprint required",
    )
    require(
        os.getenv("SUDO_USER") == "ubuntu",
        "Existing Oracle owner sudo principal required",
    )
    fingerprints = subprocess.check_output(
        [
            "/usr/bin/ssh-keygen",
            "-lf",
            "/home/ubuntu/.ssh/authorized_keys",
            "-E",
            "sha256",
        ],
        timeout=15,
        text=True,
    )
    require(
        principal in [line.split()[1] for line in fingerprints.splitlines()],
        "Owner SSH key is not authorized on this host",
    )
    root = Path(root)
    require(
        not root.exists(),
        "Existing custody preserved; explicit versioned installation required",
    )
    private(root.parent, directory=True)
    root.mkdir(mode=0o700, parents=False)
    old_umask = os.umask(0o077)
    try:
        (root / "policy.json").write_bytes(Path(policy).read_bytes())
        subprocess.run(
            [
                OPENSSL,
                "genpkey",
                "-algorithm",
                "ED25519",
                "-out",
                str(root / "signing.pem"),
            ],
            check=True,
            capture_output=True,
            timeout=15,
        )
        result = subprocess.run(
            [OPENSSL, "pkey", "-in", str(root / "signing.pem"), "-pubout"],
            check=True,
            capture_output=True,
            timeout=15,
        )
        (root / "public.pem").write_bytes(result.stdout)
        trust = {
            "schema_version": 1,
            "installation_id": str(uuid4()),
            "installed_at": timestamp().isoformat(),
            "verifier_sha256": source_pin,
            "policy_sha256": policy_pin,
            "key_id": file_digest(root / "public.pem"),
            "openssl_sha256": file_digest(OPENSSL),
            "runner_root": str(Path(runner_root).resolve()),
            "owner_ssh_principal": principal,
            "authority": "bootstrap-pending-explicit-owner-commission",
        }
        (root / "trust.json").write_bytes(canonical(trust))
        db = sqlite3.connect(root / "records.sqlite")
        db.executescript(
            "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE records(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,scope TEXT NOT NULL,envelope TEXT NOT NULL,parent TEXT REFERENCES records(id),created TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0); CREATE TABLE contexts(id TEXT PRIMARY KEY REFERENCES records(id),state TEXT NOT NULL CHECK(state IN ('issued','reserved','consumed'))); CREATE TABLE deployments(id TEXT PRIMARY KEY REFERENCES records(id),authorization TEXT NOT NULL UNIQUE REFERENCES records(id),state TEXT NOT NULL CHECK(state IN ('request-recorded','deployed-unverified','accepted')));"
        )
        db.close()
    finally:
        os.umask(old_umask)
    return trust


def commission(root, source_pin, policy_pin, key_id):
    """Separate owner bootstrap action anchors a reviewed installation; never implicit."""
    require(
        os.geteuid() == 0
        and os.getenv("SUDO_USER") == "ubuntu"
        and not os.getenv("GITHUB_ACTIONS"),
        "Explicit existing owner commissioning required",
    )
    root = Path(root)
    private(root, directory=True)
    for name in [
        "trust.json",
        "policy.json",
        "public.pem",
        "signing.pem",
        "records.sqlite",
    ]:
        private(root / name)
    trust = json.loads((root / "trust.json").read_text())
    require(
        source_pin == trust["verifier_sha256"] == file_digest(__file__)
        and policy_pin == trust["policy_sha256"] == file_digest(root / "policy.json")
        and key_id == trust["key_id"] == file_digest(root / "public.pem"),
        "Explicit reviewed source/policy/public-key pins required",
    )
    private(ANCHOR.parent, directory=True)
    if ANCHOR.exists():
        private(ANCHOR)
        registry = json.loads(ANCHOR.read_text())
    else:
        registry = {"schema_version": 1, "installations": {}}
    require(
        str(root) not in registry["installations"],
        "Existing commission preserved; no implicit overwrite",
    )
    registry["installations"][str(root)] = {
        **{
            k: trust[k]
            for k in ["installation_id", "key_id", "verifier_sha256", "policy_sha256"]
        },
        "active": True,
        "commissioned_at": timestamp().isoformat(),
    }
    with tempfile.NamedTemporaryFile(
        dir=ANCHOR.parent, prefix=".oracle-trust-", delete=False
    ) as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(canonical(registry))
        stream.flush()
        os.fsync(stream.fileno())
        path = stream.name
    os.replace(path, ANCHOR)
    descriptor = os.open(ANCHOR.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return {
        "status": "COMMISSIONED",
        **registry["installations"][str(root)],
        "store": str(root),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action",
        choices=[
            "bootstrap",
            "commission",
            "issue-context",
            "qualify",
            "authorize",
            "deploy",
            "inspect",
            "observe",
            "revoke",
        ],
    )
    parser.add_argument("--store", type=Path, required=True)
    parser.add_argument("--record")
    parser.add_argument("--policy", type=Path)
    parser.add_argument("--source-pin")
    parser.add_argument("--policy-pin")
    parser.add_argument("--runner-root", type=Path)
    parser.add_argument("--owner-ssh-principal")
    parser.add_argument("--key-id")
    args = parser.parse_args()
    require(
        os.geteuid() == 0 and not os.getenv("GITHUB_ACTIONS"),
        "External owner custody required",
    )
    if args.action == "bootstrap":
        value = bootstrap(
            args.store,
            args.policy,
            args.source_pin,
            args.policy_pin,
            args.runner_root,
            args.owner_ssh_principal,
        )
    elif args.action == "commission":
        value = commission(args.store, args.source_pin, args.policy_pin, args.key_id)
    else:
        raw = __import__("sys").stdin.buffer.read(128 * 1024 + 1)
        require(len(raw) <= 128 * 1024, "Private request size bound")
        request = json.loads(raw)
        store = Store(args.store, GitHub(request.pop("owner_token", None)))
        if args.action == "issue-context":
            require(set(request) == {"binding"}, "Unexpected context input")
            value = store.issue_context(request["binding"])
        else:
            require(
                not request and args.record,
                "Record ID required; caller approval/evidence JSON refused",
            )
            if args.action in ["inspect", "observe"]:
                value = store.inspect(args.record, observe=args.action == "observe")
            else:
                value = getattr(store, args.action)(args.record)
    print(json.dumps(value, allow_nan=False))


if __name__ == "__main__":
    main()
