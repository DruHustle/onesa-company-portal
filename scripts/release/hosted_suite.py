"""Hosted release probes using owner-provisioned synthetic staging accounts only.

No database access or destructive operations. Created fixtures remain in staging
where the application has no deletion API; their IDs are kept only in the report.
"""

import base64
import hashlib
import hmac
import http.cookiejar
import json
import os
import re
import secrets
import struct
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from evidence import PRODUCT, REPOSITORY, Rejected, require
from fixtures import FixtureError, decode_totp, parse_fixtures
from hosted import NoRedirect, preview_origin, request

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z1sAAAAASUVORK5CYII="


class HostedRequestFailure(Rejected):
    def __init__(self, status, path, body):
        self.phase = {
            "/api/v1/auth/login": "login",
            "/api/v1/auth/me": "current-user",
        }.get(path, "workflow-request")
        self.code = "HTTP_" + str(status)
        try:
            candidate = json.loads(body).get("error", {}).get("code")
        except (ValueError, AttributeError, TypeError):
            candidate = None
        known = {
            "CREDENTIALS": "FIXTURE_CREDENTIALS_REJECTED",
            "MFA": "FIXTURE_MFA_REJECTED",
            "origin_rejected": "ORIGIN_REJECTED",
            "invitation_required": "INVITATION_REQUIRED",
        }
        if isinstance(candidate, str) and candidate in known:
            self.code = known[candidate]
        super().__init__(self.code)


def safe_suite_failure_code(error):
    if isinstance(error, (FixtureError, HostedRequestFailure)):
        return error.code
    match = re.fullmatch(
        r"Synthetic hosted request failed: [A-Z]+ [a-z-]+ HTTP ([1-5][0-9]{2})",
        str(error),
    )
    if match:
        return "HTTP_" + match[1]
    known = {
        "Secure session cookie missing": "SESSION_COOKIE",
        "CSRF token missing": "CSRF_TOKEN",
    }
    return known.get(str(error), "HOSTED_CHECK")


class Session:
    def __init__(self, origin):
        self.origin = origin
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            NoRedirect(), urllib.request.HTTPCookieProcessor(self.cookies)
        )
        self.csrf = None

    def call(self, method, path, body=None, expected=200, csrf=True):
        headers = {
            "Origin": self.origin,
            "Accept": "application/json",
            "x-vercel-protection-bypass": os.environ.get(
                "VERCEL_AUTOMATION_BYPASS_SECRET", ""
            ),
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        if self.csrf and csrf:
            headers["X-CSRF-Token"] = self.csrf
        req = urllib.request.Request(
            self.origin + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers=headers,
            method=method,
        )
        try:
            with self.opener.open(req, timeout=150) as response:
                status = response.status
                # Bound streaming and file responses to avoid unbounded provider/data usage.
                content = response.read(1024 * 1024 + 1)
                require(len(content) <= 1024 * 1024, "Probe response exceeds bound")
        except urllib.error.HTTPError as error:
            status, content = error.code, error.read(4096)
        if status != expected:
            raise HostedRequestFailure(status, path, content)
        try:
            return json.loads(content)
        except ValueError:
            return content

    def login(self, user):
        payload = {"email": user["email"], "password": user["password"]}
        if PRODUCT.endswith("portal"):
            key = decode_totp(user.get("totp_secret"))
            message = struct.pack(">Q", int(time.time()) // 30)
            value = hmac.new(key, message, hashlib.sha1).digest()
            offset = value[-1] & 15
            code = (
                struct.unpack(">I", value[offset : offset + 4])[0] & 0x7FFFFFFF
            ) % 1000000
            payload["code"] = str(code).zfill(6)
        result = self.call("POST", "/api/v1/auth/login", payload)
        require(
            any(
                cookie.name == "onesa_session"
                and cookie.secure
                and cookie.has_nonstandard_attr("HttpOnly")
                for cookie in self.cookies
            ),
            "Secure session cookie missing",
        )
        self.csrf = result.get("csrf") if isinstance(result, dict) else None
        self.csrf = self.csrf or next(
            (cookie.value for cookie in self.cookies if cookie.name == "onesa_csrf"),
            None,
        )
        require(self.csrf, "CSRF token missing")
        self.call("GET", "/api/v1/auth/me")


def run_suite(origin):
    checks = {
        name: "BLOCKED"
        for name in [
            "authentication",
            "user_data_isolation",
            "critical_workflows",
            "storage_integrations",
        ]
    }
    if PRODUCT.endswith("platform"):
        checks.update(
            {"inference": "BLOCKED", "embeddings": "BLOCKED", "streaming": "BLOCKED"}
        )
    record = {
        "schema_version": 1,
        "repository": REPOSITORY,
        "candidate_commit": os.environ["GITHUB_SHA"],
        "frontend_origin": origin,
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "checks": checks,
        "synthetic_fixture_ids": [],
        "status": "BLOCKED",
    }
    raw = os.environ.get("STAGING_FIXTURES_JSON")
    if os.environ.get("STAGING_FIXTURE_MODE") == "temporary":
        from fixture_lifecycle import file_path, validate_owned

        path = file_path()
        require(
            path.is_file() and path.stat().st_mode & 0o077 == 0,
            "Private temporary fixture file required",
        )
        raw = path.read_text()
        validate_owned(json.loads(raw))
    if not raw:
        return record
    try:
        config = parse_fixtures(raw, os.environ["VERCEL_PROJECT_ID"], PRODUCT)
    except FixtureError as error:
        if error.code == "FIXTURE_BINDING":
            raise Rejected("Synthetic fixture scope mismatch") from None
        checks["authentication"] = "FAIL"
        record.update(
            status="FAIL", failure_code=error.code, failure_phase="fixture-validation"
        )
        return record
    users = config["users"]
    clients = [Session(origin), Session(origin)]
    active = "authentication"
    try:
        for client, user in zip(clients, users, strict=True):
            client.login(user)
        checks["authentication"] = "PASS"
        if PRODUCT.endswith("platform"):
            active = "critical_workflows"
            conversation = clients[0].call(
                "POST",
                "/api/v1/conversations",
                {"title": "Release synthetic " + secrets.token_hex(8)},
                expected=201,
            )["id"]
            record["synthetic_fixture_ids"].append(conversation)
            clients[0].call("GET", "/api/v1/conversations/" + conversation)
            clients[1].call(
                "GET", "/api/v1/conversations/" + conversation, expected=404
            )
            clients[0].call(
                "POST",
                "/api/v1/conversations",
                {"title": "Denied CSRF"},
                expected=403,
                csrf=False,
            )
            checks["user_data_isolation"] = "PASS"
            active = "streaming"
            response = clients[0].call(
                "POST",
                "/api/v1/chat/completions",
                {
                    "conversation_id": conversation,
                    "content": "Return the word READY.",
                    "stream": True,
                },
            )
            require(
                isinstance(response, bytes)
                and b"event: content_delta" in response
                and b"event: message_end" in response
                and b"event: error" not in response
                and b"mock" not in response.lower(),
                "Real streamed inference did not complete",
            )
            checks["streaming"] = checks["inference"] = "PASS"
            active = "embeddings"
            text = b"Synthetic release qualification document: Onesa release tests use isolated fixtures."
            upload = clients[0].call(
                "POST",
                "/api/v1/knowledge/uploads",
                {
                    "filename": "release-synthetic.txt",
                    "media_type": "text/plain",
                    "size": len(text),
                    "sha256": hashlib.sha256(text).hexdigest(),
                },
                expected=201,
            )
            identifier = upload["id"]
            clients[0].call(
                "POST",
                "/api/v1/knowledge/uploads/" + identifier + "/chunks",
                {"sequence": 0, "base64": base64.b64encode(text).decode()},
            )
            document = clients[0].call(
                "POST", "/api/v1/knowledge/uploads/" + identifier + "/complete"
            )["id"]
            record["synthetic_fixture_ids"].append(document)
            clients[0].call("GET", "/api/v1/knowledge/documents/" + document)
            clients[1].call(
                "GET", "/api/v1/knowledge/documents/" + document, expected=404
            )
            retrieved = clients[0].call(
                "POST",
                "/api/v1/knowledge/search",
                {"query": "isolated release qualification"},
            )
            require(
                retrieved["backend"] == "http"
                and any(
                    source.get("document_id") == document
                    for source in retrieved["sources"]
                ),
                "Semantic retrieval did not return the newly stored synthetic document",
            )
            checks["embeddings"] = checks["storage_integrations"] = "PASS"
            clients[0].call(
                "DELETE", "/api/v1/knowledge/documents/" + document, expected=204
            )
            clients[0].call(
                "DELETE", "/api/v1/conversations/" + conversation, expected=204
            )
            checks["critical_workflows"] = "PASS"
        else:
            active = "critical_workflows"
            # Fixture 0 must be an isolated admin; fixture 1 a restricted employee.
            clients[0].call("GET", "/api/v1/auth/me")
            clients[0].call("GET", "/api/v1/admin/files")
            clients[1].call("GET", "/api/v1/admin/files", expected=403)
            clients[0].call(
                "POST",
                "/api/v1/admin/files",
                {
                    "filename": "csrf-negative.png",
                    "base64": PNG,
                    "title": "Synthetic CSRF negative",
                },
                expected=403,
                csrf=False,
            )
            checks["user_data_isolation"] = "PASS"
            active = "storage_integrations"
            data = clients[0].call(
                "POST",
                "/api/v1/admin/files",
                {
                    "filename": "release-synthetic.png",
                    "base64": PNG,
                    "title": "Synthetic release storage " + secrets.token_hex(8),
                    "classification": "confidential",
                },
                expected=201,
            )
            identifier = data["id"]
            record["synthetic_fixture_ids"].append(identifier)
            require(
                data["sha256"] == hashlib.sha256(base64.b64decode(PNG)).hexdigest(),
                "Stored synthetic content digest differs",
            )
            clients[0].call("POST", "/api/v1/admin/files/" + identifier + "/scan", {})
            content = clients[0].call(
                "GET", "/api/v1/admin/files/" + identifier + "/download"
            )
            require(
                content == base64.b64decode(PNG),
                "Private storage/scanner roundtrip differs",
            )
            clients[1].call(
                "GET", "/api/v1/admin/files/" + identifier + "/download", expected=403
            )
            # Keep confidential classification and pending editorial approval unchanged.
            checks["storage_integrations"] = checks["critical_workflows"] = "PASS"
        record["status"] = (
            "PASS" if all(value == "PASS" for value in checks.values()) else "BLOCKED"
        )
    except (
        Rejected,
        urllib.error.URLError,
        TimeoutError,
        ValueError,
        KeyError,
    ) as error:
        checks[active] = "FAIL"
        record["status"] = "FAIL"
        record["failure_code"] = safe_suite_failure_code(error)
        record["failure_phase"] = (
            error.phase if isinstance(error, HostedRequestFailure) else active
        )
    return record


def production_probes(origin):
    checks = {
        "authenticated_critical_workflows": "BLOCKED",
        "storage_integrations": "BLOCKED",
    }
    if PRODUCT.endswith("platform"):
        checks["inference_and_streaming"] = "BLOCKED"
    raw = os.environ.get("PRODUCTION_FIXTURES_JSON")
    if not raw:
        return checks
    fixture = parse_fixtures(
        raw,
        os.environ["VERCEL_PROJECT_ID"],
        PRODUCT,
        scope="approved-synthetic-production",
    )
    users = fixture["users"]
    clients = [Session(origin), Session(origin)]
    active = "authenticated_critical_workflows"
    try:
        for client, user in zip(clients, users, strict=True):
            client.login(user)
        identifier = fixture["document_id"]
        # Existing owner-provisioned synthetic fixture only; never enumerate customer content.
        if PRODUCT.endswith("portal"):
            active = "storage_integrations"
            content = clients[0].call(
                "GET", "/api/v1/admin/files/" + identifier + "/download"
            )
            require(
                hashlib.sha256(content).hexdigest() == fixture["document_sha256"],
                "Production synthetic storage digest mismatch",
            )
            clients[1].call(
                "GET", "/api/v1/admin/files/" + identifier + "/download", expected=403
            )
        else:
            active = "storage_integrations"
            clients[0].call("GET", "/api/v1/knowledge/documents/" + identifier)
            clients[1].call(
                "GET", "/api/v1/knowledge/documents/" + identifier, expected=404
            )
            found = clients[0].call(
                "POST",
                "/api/v1/knowledge/search",
                {"query": "isolated release qualification"},
            )
            require(
                found["backend"] == "http"
                and any(
                    source["document_id"] == identifier for source in found["sources"]
                ),
                "Production semantic storage retrieval mismatch",
            )
            active = "inference_and_streaming"
            conversation = fixture["conversation_id"]
            clients[1].call(
                "GET", "/api/v1/conversations/" + conversation, expected=404
            )
            response = clients[0].call(
                "POST",
                "/api/v1/chat/completions",
                {
                    "conversation_id": conversation,
                    "content": "Return the word READY.",
                    "stream": True,
                },
            )
            require(
                isinstance(response, bytes)
                and b"event: content_delta" in response
                and b"event: message_end" in response
                and b"event: error" not in response
                and b"mock" not in response.lower(),
                "Production streamed inference failed",
            )
            checks["inference_and_streaming"] = "PASS"
        checks["storage_integrations"] = checks["authenticated_critical_workflows"] = (
            "PASS"
        )
    except (Rejected, ValueError, KeyError, urllib.error.URLError, TimeoutError):
        checks[active] = "FAIL"
    return checks


def main():
    origin = preview_origin("/tmp/vercel-url.txt")
    # Validate the actual Preview/candidate before any authenticated/writing probes.
    from hosted import frontend, preflight

    preflight()
    frontend(origin, os.environ["GITHUB_SHA"], "Staging")
    status, _ = request(origin)
    require(status in {401, 403, 302, 303, 307}, "Staging Preview is not protected")
    record = run_suite(origin)
    Path(os.environ["RUNNER_TEMP"], "hosted-suite.json").write_text(json.dumps(record))
    print("Synthetic hosted suite: " + record["status"])
    if record.get("failure_code"):
        print("Hosted check failure: " + record["failure_code"])
        print(
            "Hosted failure phase: " + record.get("failure_phase", "workflow-request")
        )


if __name__ == "__main__":
    try:
        main()
    except (Rejected, ValueError, KeyError, OSError):
        raise SystemExit(
            "Synthetic hosted suite blocked; configure isolated fixtures privately"
        ) from None
