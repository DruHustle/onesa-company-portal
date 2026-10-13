"""Allowlisted hosted receipt checks. Never mutate databases or log response bodies."""

import argparse
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from evidence import (
    POLICY,
    PRODUCT,
    REPOSITORY,
    GitHub,
    Rejected,
    digest,
    require,
    save,
    staging_check_names,
    trusted_run,
    verify_stage,
)
from fixtures import FixtureError, parse_fixtures

STAGING_SERVICES = {
    "onesa-company-portal": "srv-db5k5had0e5s73fos4g0",
    "onesa-ai-platform": "srv-db56mju7bikc73950f60",
}
BACKEND_ORIGINS = {
    "onesa-company-portal": "https://onesa-company-portal-backend-staging.onrender.com",
    "onesa-ai-platform": "https://onesa-ai-platform-backend-staging.onrender.com",
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(url, token=None, bypass=None, raw=False):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if bypass:
        headers["x-vercel-protection-bypass"] = bypass
    req = urllib.request.Request(url, headers=headers)
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(req, timeout=45) as response:
            body = response.read(1024 * 1024)
            if raw:
                return response.status, body
            try:
                data = json.loads(body)
            except ValueError:
                data = None
            return response.status, data
    except urllib.error.HTTPError as error:
        return error.code, None
    except (urllib.error.URLError, TimeoutError):
        return 0, None


# Fixed diagnostic codes expose no provider values, URLs, response bodies or exception text.
FAILURE_CODES = {
    "Hosted staging acceptance incomplete": "STAGING_ACCEPTANCE",
    "Provider credential missing": "PROVIDER_CREDENTIAL_MISSING",
    "Provider readback unavailable": "PROVIDER_ACCESS",
    "Render credential missing": "RENDER_CREDENTIAL_MISSING",
    "Render readback unavailable": "RENDER_ACCESS",
    "Vercel credential missing": "VERCEL_CREDENTIAL_MISSING",
    "Vercel readback unavailable": "VERCEL_ACCESS",
    "Unapproved staging branch": "STAGING_BRANCH",
    "Staging target identity mismatch": "STAGING_RENDER_IDENTITY",
    "Only the existing free staging target is authorized": "STAGING_FREE_PLAN",
    "Staging native auto-deploy must be disabled": "STAGING_AUTO_DEPLOY",
    "Complete staging environment readback required": "STAGING_ENVIRONMENT_INVENTORY",
    "Staging synthetic probes require the identified isolated runtime database": "STAGING_DATABASE_BINDING",
    "Portal cloud staging must retain production protections": "STAGING_RUNTIME_MODE",
    "Full release probes require actual configured inference and semantic embeddings": "STAGING_INFERENCE_CONFIGURATION",
    "Staging Vercel project missing": "STAGING_VERCEL_BINDING",
    "Staging frontend repository binding mismatch": "STAGING_FRONTEND_REPOSITORY",
    "Staging Preview is not access protected": "STAGING_PREVIEW_PROTECTION",
    "Identified hosted development operator required": "PREVIEW_OWNER_CONTEXT",
    "Staging API proxy credential missing": "STAGING_PROXY_CREDENTIAL",
    "Preview settings update failed": "PREVIEW_SETTINGS_WRITE",
    "Preview settings update unavailable": "PREVIEW_SETTINGS_PROVIDER",
    "Production environment changed during Preview repair": "PREVIEW_PRODUCTION_READBACK",
    "Preview settings readback failed": "PREVIEW_SETTINGS_READBACK",
    "Preview private value is not decrypted": "PREVIEW_SETTINGS_UNDECRYPTED",
}


def safe_failure_code(error):
    if isinstance(error, FixtureError):
        return error.code
    if isinstance(error, Rejected):
        return FAILURE_CODES.get(str(error), "VALIDATION")
    if isinstance(error, KeyError):
        return "CONFIGURATION_INPUT_MISSING"
    if isinstance(error, OSError):
        return "NETWORK_OR_FILE_ACCESS"
    return "CONFIGURATION_FORMAT"


def provider(url, token):
    provider_name = (
        "Render"
        if url.startswith("https://api.render.com/")
        else "Vercel"
        if url.startswith("https://api.vercel.com/")
        else "Provider"
    )
    require(token, provider_name + " credential missing")
    status, data = request(url, token=token)
    require(
        status == 200 and isinstance(data, (dict, list)),
        provider_name + " readback unavailable",
    )
    return data


def preview_origin(path):
    origin = Path(path).read_text().strip()
    parsed = urllib.parse.urlsplit(origin)
    require(
        parsed.scheme == "https"
        and parsed.hostname
        and parsed.hostname.endswith(".vercel.app")
        and not parsed.username
        and not parsed.password
        and not parsed.port
        and not parsed.path
        and not parsed.query
        and not parsed.fragment,
        "Invalid Vercel deployment origin",
    )
    return origin


def frontend(origin, sha, environment, project=None):
    team = os.environ["VERCEL_ORG_ID"]
    project = project or os.environ["VERCEL_PROJECT_ID"]
    require(
        re.fullmatch(r"(team|user)_[A-Za-z0-9]+", team) is not None
        and re.fullmatch(r"prj_[A-Za-z0-9]+", project) is not None,
        "Invalid Vercel binding",
    )
    data = provider(
        "https://api.vercel.com/v13/deployments/"
        + origin.split("//", 1)[1]
        + "?"
        + urllib.parse.urlencode({"teamId": team}),
        os.environ["VERCEL_TOKEN"],
    )
    require(
        data.get("projectId") == project
        and data.get("readyState") == "READY"
        and data.get("meta", {}).get("githubCommitSha") == sha,
        "Vercel candidate identity or readiness mismatch",
    )
    require(
        (data.get("target") == "production") == (environment == "Production"),
        "Vercel environment mismatch",
    )
    return data


def render(service, identifier, sha):
    require(
        re.fullmatch(r"srv-[a-zA-Z0-9]+", service) is not None
        and re.fullmatch(r"dep-[a-zA-Z0-9]+", identifier) is not None,
        "Invalid Render binding",
    )
    data = provider(
        f"https://api.render.com/v1/services/{service}/deploys/{identifier}",
        os.environ["RENDER_API_KEY"],
    )
    require(
        data.get("status") == "live" and data.get("commit", {}).get("id") == sha,
        "Render deployment unavailable or wrong commit",
    )
    # A historical live deploy can survive in API history; require the newest deployment.
    latest = provider(
        f"https://api.render.com/v1/services/{service}/deploys?limit=1",
        os.environ["RENDER_API_KEY"],
    )
    require(
        latest and latest[0].get("deploy", latest[0]).get("id") == identifier,
        "Staging was replaced by another deployment",
    )
    return data


def require_stage_acceptance(record):
    checks = record.get("checks")
    require(
        record.get("status") == "PASS"
        and isinstance(checks, dict)
        and staging_check_names() <= checks.keys()
        and all(value == "PASS" for value in checks.values()),
        "Hosted staging acceptance incomplete",
    )


def preflight(*, configuration_dev=False):
    require(
        os.environ["GITHUB_REF"] == "refs/heads/" + POLICY["staging_branch"]
        or (configuration_dev and os.environ["GITHUB_REF"] == "refs/heads/dev")
        or (
            os.environ.get("GITHUB_EVENT_NAME") == "workflow_run"
            and os.environ["GITHUB_REF"] == "refs/heads/main"
            and GitHub().api(f"repos/{REPOSITORY}/branches/{POLICY['staging_branch']}")[
                "commit"
            ]["sha"]
            == os.environ["GITHUB_SHA"]
        ),
        "Unapproved staging branch",
    )
    service = provider(
        "https://api.render.com/v1/services/" + STAGING_SERVICES[PRODUCT],
        os.environ["RENDER_API_KEY"],
    )
    require(
        service.get("repo") == "https://github.com/" + REPOSITORY
        and service.get("branch") == POLICY["staging_branch"]
        and service.get("type") == "web_service",
        "Staging target identity mismatch",
    )
    require(
        service.get("serviceDetails", {}).get("plan") == "free",
        "Only the existing free staging target is authorized",
    )
    require(
        service.get("autoDeployTrigger") == "off" or service.get("autoDeploy") == "no",
        "Staging native auto-deploy must be disabled",
    )
    entries = provider(
        "https://api.render.com/v1/services/"
        + STAGING_SERVICES[PRODUCT]
        + "/env-vars?limit=100",
        os.environ["RENDER_API_KEY"],
    )
    require(
        isinstance(entries, list) and len(entries) < 100,
        "Complete staging environment readback required",
    )
    settings = {entry["envVar"]["key"]: entry["envVar"]["value"] for entry in entries}
    database_key = (
        "ONESA_DATABASE_URL" if PRODUCT.endswith("platform") else "DATABASE_URL"
    )
    url = urllib.parse.urlsplit(settings.get(database_key, ""))
    expected_host = (
        "ep-falling-thunder-b9x4ka3b-pooler.c-7.eu-central-1.aws.neon.tech"
        if PRODUCT.endswith("platform")
        else "ep-morning-shadow-b9jkzgsz-pooler.c-7.eu-central-1.aws.neon.tech"
    )
    require(
        url.hostname == expected_host
        and url.username
        == (
            "onesa_ai_staging_app"
            if PRODUCT.endswith("platform")
            else "onesa_portal_app"
        )
        and url.path == "/neondb",
        "Staging synthetic probes require the identified isolated runtime database",
    )
    if PRODUCT.endswith("portal"):
        require(
            settings.get("NODE_ENV") == "production",
            "Portal cloud staging must retain production protections",
        )
    if PRODUCT.endswith("platform") and os.environ.get("STAGING_FIXTURES_JSON"):
        require(
            settings.get("ONESA_ENVIRONMENT") == "staging"
            and settings.get("ONESA_MODEL_BACKEND") in {"ollama", "vllm"}
            and settings.get("ONESA_EMBEDDING_BACKEND") == "http",
            "Full release probes require actual configured inference and semantic embeddings",
        )
    fixture_input = os.environ.get("STAGING_FIXTURES_JSON")
    if fixture_input:
        parse_fixtures(
            fixture_input,
            os.environ.get("VERCEL_PROJECT_ID", ""),
            PRODUCT,
            credentials=os.environ.get("STAGING_FIXTURE_MODE", "provided")
            != "temporary",
        )
    project_id = os.environ.get("VERCEL_PROJECT_ID", "")
    require(
        re.fullmatch(r"prj_[A-Za-z0-9]+", project_id) is not None,
        "Staging Vercel project missing",
    )
    query = urllib.parse.urlencode({"teamId": os.environ["VERCEL_ORG_ID"]})
    project = provider(
        "https://api.vercel.com/v9/projects/" + project_id + "?" + query,
        os.environ["VERCEL_TOKEN"],
    )
    link = project.get("link", {})
    require(
        link.get("org") == "DruHustle" and link.get("repo") == PRODUCT,
        "Staging frontend repository binding mismatch",
    )
    require(
        (project.get("ssoProtection") or {}).get("deploymentType")
        in {
            "all",
            "all_except_custom_domains",
            "preview",
            "prod_deployment_urls_and_all_previews",
        },
        "Staging Preview is not access protected",
    )
    # Preflight does not change configuration; origin binding is a separately scoped operation.
    return {"service": service, "settings": settings, "project": project}


def resolve_preview(output, *, attempts=60):
    """Reuse the exact native Git Preview; never create a competing deployment."""
    preflight()
    query = urllib.parse.urlencode(
        {
            "projectId": os.environ["VERCEL_PROJECT_ID"],
            "teamId": os.environ["VERCEL_ORG_ID"],
            "limit": 100,
        }
    )
    for attempt in range(attempts):
        data = provider(
            "https://api.vercel.com/v6/deployments?" + query, os.environ["VERCEL_TOKEN"]
        )
        candidates = [
            item
            for item in data.get("deployments", [])
            if item.get("meta", {}).get("githubCommitSha") == os.environ["GITHUB_SHA"]
            and item.get("meta", {}).get("githubCommitRef") == "staging"
            and item.get("target") in {None, "preview"}
        ]
        ready = [
            item
            for item in candidates
            if item.get("readyState", item.get("state")) == "READY"
        ]
        if ready:
            require(
                len(ready) == 1,
                "Multiple native staging Previews for the same source; reconcile deployment authorities",
            )
            origin = "https://" + ready[0]["url"]
            frontend(origin, os.environ["GITHUB_SHA"], "Staging")
            Path(output).write_text(origin + "\n")
            print("Verified exact-source native Git staging Preview")
            return origin
        require(
            not any(
                item.get("readyState", item.get("state")) in {"ERROR", "CANCELED"}
                for item in candidates
            ),
            "Native staging Preview build failed",
        )
        if attempt + 1 < attempts:
            time.sleep(5)
    raise Rejected("No ready native Git staging Preview for the exact candidate")


def stage(qualification, render_receipt, origin):
    sha = os.environ["GITHUB_SHA"]
    receipt = json.loads(Path(render_receipt).read_text())
    require(
        receipt["service_id"] == STAGING_SERVICES[PRODUCT] and receipt["commit"] == sha,
        "Staging receipt identity mismatch",
    )
    render(receipt["service_id"], receipt["deployment_id"], sha)
    deployment = frontend(origin, sha, "Staging")
    backend = BACKEND_ORIGINS[PRODUCT]
    readiness = "/api/v1/ready" if PRODUCT.endswith("portal") else "/ready"
    core = readiness if PRODUCT.endswith("portal") else "/core-ready"
    bypass = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET")
    checks = {
        "deployed_commit": "PASS",
        "backend_readiness": "PASS"
        if request(backend + readiness)[0] == 200
        else "FAIL",
        "database_connectivity": "PASS"
        if request(backend + core)[0] == 200
        else "FAIL",
        "frontend_availability": "PASS"
        if request(origin + "/", bypass=bypass)[0] == 200
        else "FAIL",
        "authentication": "PASS"
        if request(backend + "/api/v1/auth/me")[0] == 401
        else "FAIL",
        "critical_workflows": "NOT TESTED",
        "user_data_isolation": "NOT TESTED",
        "storage_integrations": "NOT TESTED",
    }
    # Negative anonymous authentication is recorded separately from a full authenticated flow.
    checks["anonymous_authentication_denied"] = checks["authentication"]
    checks["authentication"] = "NOT TESTED"
    if PRODUCT.endswith("platform"):
        checks.update(
            {"streaming": "NOT TESTED", "inference": "BLOCKED", "embeddings": "BLOCKED"}
        )
    suite_path = Path(os.environ["RUNNER_TEMP"], "hosted-suite.json")
    if suite_path.exists():
        suite = json.loads(suite_path.read_text())
        require(
            suite["repository"] == REPOSITORY
            and suite["candidate_commit"] == sha
            and suite["frontend_origin"] == origin,
            "Synthetic suite candidate mismatch",
        )
        for name, result in suite["checks"].items():
            require(
                name in checks and result in {"PASS", "FAIL", "BLOCKED", "NOT TESTED"},
                "Unsupported hosted check",
            )
            checks[name] = result
    status = (
        "PASS"
        if all(value == "PASS" for value in checks.values())
        else "FAIL"
        if "FAIL" in checks.values()
        else "BLOCKED"
    )
    return {
        "schema_version": 1,
        "repository": REPOSITORY,
        "candidate_commit": sha,
        "source_sha256": qualification["valid_for_source_sha256"],
        "builds_sha256": digest(qualification["builds"]),
        "environment": "Staging",
        "status": status,
        "checks": checks,
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "workflow_run_id": int(os.environ["GITHUB_RUN_ID"]),
        "render_service_id": receipt["service_id"],
        "render_deployment_id": receipt["deployment_id"],
        "vercel_deployment_id": deployment["id"],
        "frontend_origin": origin,
        "backend_origin": backend,
        "limitations": [
            "Complete authenticated, integration and dependency acceptance is required; see the individual hosted check results"
        ],
    }


def recheck(evidence):
    stage_record = evidence["staging"]["record"]
    require(
        verify_stage(
            stage_record,
            evidence["candidate_commit"],
            evidence["valid_for_source_sha256"],
            evidence["builds"],
        )
        == "PASS",
        "Staging incomplete",
    )
    require(
        stage_record["render_service_id"] == STAGING_SERVICES[PRODUCT]
        and stage_record["backend_origin"] == BACKEND_ORIGINS[PRODUCT],
        "Staging target mismatch",
    )
    render(
        stage_record["render_service_id"],
        stage_record["render_deployment_id"],
        evidence["candidate_commit"],
    )
    origin = stage_record["frontend_origin"]
    # Revalidate hostname before sending any bypass credential.
    parsed = urllib.parse.urlsplit(origin)
    require(
        parsed.scheme == "https"
        and parsed.hostname
        and parsed.hostname.endswith(".vercel.app")
        and not parsed.username
        and not parsed.password
        and not parsed.path
        and not parsed.query
        and not parsed.fragment,
        "Untrusted staging origin",
    )
    deployment = frontend(
        origin,
        evidence["candidate_commit"],
        "Staging",
        project=os.environ.get("STAGING_VERCEL_PROJECT_ID"),
    )
    require(
        deployment["id"] == stage_record["vercel_deployment_id"],
        "Frontend deployment mismatch",
    )
    readiness = "/api/v1/ready" if PRODUCT.endswith("portal") else "/ready"
    require(
        request(stage_record["backend_origin"] + readiness)[0] == 200,
        "Staging backend unavailable",
    )
    require(
        request(origin + "/", bypass=os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET"))[
            0
        ]
        == 200,
        "Staging frontend unavailable",
    )


def production_metrics(backend_url, service_id):
    entries = provider(
        "https://api.render.com/v1/services/" + service_id + "/env-vars?limit=100",
        os.environ["RENDER_API_KEY"],
    )
    require(
        len(entries) < 100,
        "Complete production metrics configuration readback required",
    )
    settings = {entry["envVar"]["key"]: entry["envVar"]["value"] for entry in entries}
    token = settings.get(
        "METRICS_TOKEN" if PRODUCT.endswith("portal") else "ONESA_METRICS_TOKEN"
    )
    if not token:
        return {"application_errors": "BLOCKED", "monitoring_signals": "BLOCKED"}
    path = "/api/v1/metrics" if PRODUCT.endswith("portal") else "/metrics"
    status, body = request(backend_url + path, token=token, raw=True)
    require(status == 200 and isinstance(body, bytes), "Production metrics unavailable")
    metrics = body.decode()
    prefix = (
        "onesa_portal_http_requests_total"
        if PRODUCT.endswith("portal")
        else "onesa_http_requests_total"
    )
    samples = [line for line in metrics.splitlines() if line.startswith(prefix + "{")]
    require(
        samples
        and any(
            'status="2' in sample and float(sample.rsplit(" ", 1)[-1]) > 0
            for sample in samples
        ),
        "Monitoring did not capture actual successful request signals",
    )
    server_errors = sum(
        float(sample.rsplit(" ", 1)[-1])
        for sample in samples
        if re.search(r'status="5(?:xx|[0-9]{2})"', sample)
    )
    return {
        "application_errors": "PASS" if server_errors == 0 else "FAIL",
        "monitoring_signals": "PASS",
        "observed_5xx_count": server_errors,
    }


def production():
    github = GitHub()
    sha = os.environ["GITHUB_SHA"]
    current = github.run(os.environ["GITHUB_RUN_ID"])
    trusted_run(current, "deploy.yml", sha, {"main"}, completed=False)
    result = {
        "schema_version": 1,
        "repository": REPOSITORY,
        "candidate_commit": sha,
        "environment": "Production",
        "workflow_run_id": current["id"],
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "deployments": [],
        "checks": {
            "application_errors": "NOT TESTED",
            "authenticated_critical_workflows": "NOT TESTED",
            "storage_integrations": "NOT TESTED",
            "monitoring_signals": "NOT TESTED",
        },
        "status": "BLOCKED",
        "rollback": "Owner must follow reviewed provider rollback; no migrations or secrets are reversed automatically",
    }
    if PRODUCT.endswith("platform"):
        result["checks"]["inference_and_streaming"] = "NOT TESTED"
    try:
        application = os.environ["APPLICATION"]
        smoke_origin = None
        if application in {"both", "backend"}:
            for unit in (
                ["backend", "worker"] if PRODUCT.endswith("portal") else ["backend"]
            ):
                receipt, origin = github.artifact(
                    current, "production-" + unit + "-deployment"
                )
                require(
                    receipt["service_id"]
                    == os.environ["RENDER_" + unit.upper() + "_SERVICE_ID"],
                    "Production Render binding mismatch",
                )
                render(receipt["service_id"], receipt["deployment_id"], sha)
                result["deployments"].append(
                    {"unit": unit, "receipt": receipt, "artifact": origin}
                )
                result["checks"][unit + "_deployed_commit"] = "PASS"
                if unit == "backend":
                    service = provider(
                        "https://api.render.com/v1/services/" + receipt["service_id"],
                        os.environ["RENDER_API_KEY"],
                    )
                    url = service.get("serviceDetails", {}).get("url", "")
                    parsed = urllib.parse.urlsplit(url)
                    require(
                        parsed.scheme == "https"
                        and parsed.hostname
                        and parsed.hostname.endswith(".onrender.com")
                        and not parsed.username
                        and not parsed.port
                        and not parsed.path,
                        "Production backend origin unverified",
                    )
                    path = "/api/v1/ready" if PRODUCT.endswith("portal") else "/ready"
                    result["checks"]["backend_readiness"] = (
                        "PASS" if request(url + path)[0] == 200 else "FAIL"
                    )
                    result["checks"]["anonymous_authentication_denied"] = (
                        "PASS" if request(url + "/api/v1/auth/me")[0] == 401 else "FAIL"
                    )
        if application in {"both", "frontend"}:
            receipt, origin = github.artifact(current, "production-frontend-deployment")
            data = frontend(receipt["origin"], sha, "Production")
            require(
                data["id"] == receipt["deployment_id"],
                "Production frontend deployment mismatch",
            )
            result["deployments"].append(
                {"unit": "frontend", "receipt": receipt, "artifact": origin}
            )
            result["checks"]["frontend_deployed_commit"] = "PASS"
            result["checks"]["frontend_availability"] = (
                "PASS" if request(receipt["origin"] + "/")[0] == 200 else "FAIL"
            )
            smoke_origin = receipt["origin"]
        if smoke_origin is None:
            query = urllib.parse.urlencode({"teamId": os.environ["VERCEL_ORG_ID"]})
            project = provider(
                "https://api.vercel.com/v9/projects/"
                + os.environ["VERCEL_PROJECT_ID"]
                + "?"
                + query,
                os.environ["VERCEL_TOKEN"],
            )
            host = project.get("targets", {}).get("production", {}).get("url", "")
            require(
                host.endswith(".vercel.app") and re.fullmatch(r"[A-Za-z0-9.-]+", host),
                "Current production frontend is unavailable",
            )
            smoke_origin = "https://" + host
        from hosted_suite import production_probes

        result["checks"].update(production_probes(smoke_origin))
        service_id = os.environ["RENDER_BACKEND_SERVICE_ID"]
        service = provider(
            "https://api.render.com/v1/services/" + service_id,
            os.environ["RENDER_API_KEY"],
        )
        require(
            service.get("repo") == "https://github.com/" + REPOSITORY
            and service.get("branch") == "main",
            "Production backend repository/branch mismatch",
        )
        backend_url = service["serviceDetails"]["url"]
        parsed = urllib.parse.urlsplit(backend_url)
        require(
            parsed.scheme == "https"
            and parsed.hostname
            and parsed.hostname.endswith(".onrender.com")
            and not parsed.username
            and not parsed.password
            and not parsed.port
            and not parsed.path,
            "Production backend origin mismatch",
        )
        result["checks"]["database_connectivity"] = (
            "PASS"
            if request(
                backend_url
                + ("/api/v1/ready" if PRODUCT.endswith("portal") else "/core-ready")
            )[0]
            == 200
            else "FAIL"
        )
        monitored = production_metrics(backend_url, service_id)
        result["checks"].update(
            {
                key: value
                for key, value in monitored.items()
                if key != "observed_5xx_count"
            }
        )
        result["observed_5xx_count"] = monitored.get("observed_5xx_count")

    except (Rejected, KeyError, OSError, ValueError):
        result["checks"]["provider_revision_readback"] = "FAIL"
    if "FAIL" in result["checks"].values():
        result["status"] = "FAIL"
    elif all(value == "PASS" for value in result["checks"].values()):
        result["status"] = "PASS"
    return result


def configure_staging_preview():
    """Only the approved staging API's server settings may reach its Git Preview."""
    require(PRODUCT == "onesa-company-portal" and os.environ.get("GITHUB_REPOSITORY") == REPOSITORY and os.environ.get("GITHUB_REF") == "refs/heads/dev" and os.environ.get("GITHUB_ACTOR") == "DruHustle" and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted", "Identified hosted development operator required")
    verified = preflight(configuration_dev=True)
    proxy = verified["settings"].get("PROXY_SHARED_KEY", "")
    require(isinstance(proxy, str) and len(proxy) >= 32, "Staging API proxy credential missing")
    project, team = os.environ["VERCEL_PROJECT_ID"], os.environ["VERCEL_ORG_ID"]
    query = urllib.parse.urlencode({"teamId": team, "decrypt": "true"})
    endpoint = "https://api.vercel.com/v10/projects/" + project + "/env?" + query
    before = provider(endpoint, os.environ["VERCEL_TOKEN"]).get("envs", [])
    production = [item for item in before if "production" in item.get("target", [])]
    payload = [{"key": key, "value": value, "type": kind, "target": ["preview"], "gitBranch": "staging"} for key, value, kind in [("BACKEND_URL", BACKEND_ORIGINS[PRODUCT], "plain"), ("PROXY_SHARED_KEY", proxy, "encrypted")]]
    url = "https://api.vercel.com/v10/projects/" + project + "/env?" + urllib.parse.urlencode({"teamId": team, "upsert": "true"})
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Authorization": "Bearer " + os.environ["VERCEL_TOKEN"], "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=45) as response:
            require(response.status in {200, 201}, "Preview settings update failed")
    except (urllib.error.URLError, TimeoutError):
        raise Rejected("Preview settings update unavailable") from None
    after = provider(endpoint, os.environ["VERCEL_TOKEN"]).get("envs", [])
    require([item for item in after if "production" in item.get("target", [])] == production, "Production environment changed during Preview repair")
    for key, value in [("BACKEND_URL", BACKEND_ORIGINS[PRODUCT]), ("PROXY_SHARED_KEY", proxy)]:
        matches = [item for item in after if item.get("key") == key and item.get("target") == ["preview"] and item.get("gitBranch") == "staging"]
        require(len(matches) == 1, "Preview settings readback failed")
        entry = matches[0]
        if key == "PROXY_SHARED_KEY":
            identifier = entry.get("id", "")
            require(isinstance(identifier, str) and re.fullmatch(r"[A-Za-z0-9_-]+", identifier), "Preview settings readback failed")
            entry = provider("https://api.vercel.com/v1/projects/" + project + "/env/" + identifier + "?" + urllib.parse.urlencode({"teamId": team}), os.environ["VERCEL_TOKEN"])
            require(entry.get("id") == identifier and entry.get("key") == key and entry.get("target") == ["preview"] and entry.get("gitBranch") == "staging", "Preview settings readback failed")
            require(entry.get("decrypted") is True, "Preview private value is not decrypted")
        require(entry.get("value") == value, "Preview settings readback failed")
    print("Staging Preview routing verified; production unchanged; no deployment requested")


def bind_staging_origin():
    # The only allowed write: current Preview origin on the already approved staging API.
    # Preflight verifies repository, branch, free plan, native deploy pause and isolated DB.
    preflight()
    origin = preview_origin("/tmp/vercel-url.txt")
    frontend(origin, os.environ["GITHUB_SHA"], "Staging")
    key = "ONESA_PUBLIC_ORIGIN" if PRODUCT.endswith("platform") else "PUBLIC_ORIGIN"
    req = urllib.request.Request(
        "https://api.render.com/v1/services/"
        + STAGING_SERVICES[PRODUCT]
        + "/env-vars/"
        + key,
        data=json.dumps({"value": origin}).encode(),
        headers={
            "Authorization": "Bearer " + os.environ["RENDER_API_KEY"],
            "Content-Type": "application/json",
        },
        method="PUT",
    )
    try:
        with urllib.request.build_opener(NoRedirect()).open(
            req, timeout=45
        ) as response:
            require(response.status in {200, 201}, "Staging origin update failed")
    except (urllib.error.URLError, TimeoutError):
        raise Rejected("Staging origin update unavailable") from None
    entries = provider(
        "https://api.render.com/v1/services/"
        + STAGING_SERVICES[PRODUCT]
        + "/env-vars?limit=100",
        os.environ["RENDER_API_KEY"],
    )
    require(
        any(
            entry["envVar"]["key"] == key and entry["envVar"]["value"] == origin
            for entry in entries
        ),
        "Staging origin readback failed",
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "mode",
        choices=[
            "preflight",
            "stage",
            "stage-result",
            "resolve-preview",
            "recheck",
            "frontend-receipt",
            "bind-staging-origin",
            "configure-staging-preview",
            "production",
        ],
    )
    parser.add_argument("--evidence")
    parser.add_argument("--render-receipt")
    parser.add_argument(
        "--environment", default="Staging", choices=["Staging", "Production"]
    )
    parser.add_argument("--url-file", default="/tmp/vercel-url.txt")
    parser.add_argument("--output", default="data/release/record.json")
    args = parser.parse_args()
    if args.mode == "resolve-preview":
        resolve_preview(args.url_file)
    elif args.mode == "stage-result":
        record = json.loads(Path(args.evidence).read_text())
        print("Hosted qualification:", record.get("status"))
        print(json.dumps(record.get("checks", {}), indent=2))
        require_stage_acceptance(record)
    elif args.mode == "bind-staging-origin":
        bind_staging_origin()
    elif args.mode == "configure-staging-preview":
        configure_staging_preview()
    elif args.mode == "production":
        save(production(), args.output)
    elif args.mode == "preflight":
        preflight()
    elif args.mode == "recheck":
        recheck(json.loads(Path(args.evidence).read_text()))
    elif args.mode == "stage":
        save(
            stage(
                json.loads(Path(args.evidence).read_text()),
                args.render_receipt,
                preview_origin(args.url_file),
            ),
            args.output,
        )
    else:
        origin = preview_origin(args.url_file)
        data = frontend(origin, os.environ["GITHUB_SHA"], args.environment)
        save(
            {
                "repository": REPOSITORY,
                "commit": os.environ["GITHUB_SHA"],
                "environment": args.environment,
                "deployment_id": data["id"],
                "origin": origin,
                "provider_ready": True,
                "verified_at": datetime.now(timezone.utc).isoformat(),
            },
            args.output,
        )


if __name__ == "__main__":
    try:
        main()
    except (Rejected, OSError, KeyError, ValueError, TypeError) as error:
        raise SystemExit(
            "Hosted qualification blocked ["
            + safe_failure_code(error)
            + "]; check scoped configuration privately"
        ) from None
