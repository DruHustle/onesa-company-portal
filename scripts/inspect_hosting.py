"""Read-only provider diagnostics; emit only allowlisted configuration checks."""

import json
import os
import re
import urllib.error
import urllib.request
from urllib.parse import urlencode, urlsplit


def get_json(origin, path, token):
    request = urllib.request.Request(
        origin + path, headers={"Authorization": "Bearer " + token}
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response), response.status
    except urllib.error.HTTPError as error:
        return {}, error.code
    except (urllib.error.URLError, TimeoutError, ValueError):
        return {}, 0


def environment_checks(entries, required, wrapper=None):
    values = {}
    for entry in entries:
        if wrapper:
            entry = entry.get(wrapper, entry)
        key = entry.get("key", "")
        if key in required:
            values[key] = bool(entry.get("value"))
    return {key: values.get(key, False) for key in required}


def safe_commit(value):
    return (
        value
        if isinstance(value, str) and re.fullmatch(r"[a-f0-9]{40}", value)
        else None
    )


def health(origin, path):
    parsed = urlsplit(origin)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or not parsed.hostname.endswith(".onrender.com")
        or parsed.username
        or parsed.password
        or parsed.port not in {None, 443}
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        return None
    try:
        with urllib.request.urlopen(origin.rstrip("/") + path, timeout=30) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (urllib.error.URLError, TimeoutError):
        return 0


def log_categories(data):
    messages = "\n".join(str(item.get("message", "")) for item in data.get("logs", []))
    patterns = {
        "docker_context_or_file_missing": r"(?i)(failed to read dockerfile|dockerfile.*no such file|failed to calculate checksum|package.json.*not found)",
        "package_manager_removed_from_runtime": r"(?i)(npm:.*not found|cannot find module.*npm|exec:.*npm.*not found)",
        "environment_validation_failed": r"(?i)(validationerror|zoderror|production requires|database_url.*required)",
        "database_connection_failed": r"(?i)(password authentication failed|connection refused|could not connect|database is not configured)",
        "schema_not_current": r"(?i)(schema.*revision|migration.*required|schema.*not.*current)",
    }
    return [name for name, pattern in patterns.items() if re.search(pattern, messages)]


def render(role, service, required, expected_root, expected_health):
    token = os.environ.get("RENDER_API_KEY", "")
    if not token or not re.fullmatch(r"srv-[a-zA-Z0-9]+", service):
        return {"role": role, "configured": False}
    data, status = get_json("https://api.render.com/v1/", "services/" + service, token)
    if status != 200:
        return {"role": role, "api_http": status}
    details = data.get("serviceDetails", {})
    runtime = details.get("envSpecificDetails", {})
    env, env_status = get_json(
        "https://api.render.com/v1/",
        "services/" + service + "/env-vars?limit=100",
        token,
    )
    deployments, deploy_status = get_json(
        "https://api.render.com/v1/", "services/" + service + "/deploys?limit=3", token
    )
    latest = (
        deployments[0].get("deploy", deployments[0])
        if isinstance(deployments, list) and deployments
        else {}
    )
    state = latest.get("status")
    states = {
        "live",
        "created",
        "build_in_progress",
        "update_in_progress",
        "build_failed",
        "update_failed",
        "pre_deploy_failed",
        "canceled",
        "deactivated",
    }
    origin = details.get("url", "")
    owner = data.get("ownerId", "")
    log_data, log_status = get_json(
        "https://api.render.com/v1/",
        "logs?" + urlencode({"ownerId": owner, "resource": service, "limit": 100}),
        token,
    )
    return {
        "role": role,
        "api_http": status,
        "service_type": data.get("type")
        if data.get("type")
        in {
            "web_service",
            "background_worker",
            "private_service",
            "cron_job",
            "static_site",
        }
        else "unknown",
        "runtime": details.get("runtime", details.get("env"))
        if details.get("runtime", details.get("env"))
        in {"docker", "node", "python", "image"}
        else "unknown",
        "main_branch": data.get("branch") == "main",
        "native_auto_deploy_disabled": data.get("autoDeployTrigger") == "off"
        or data.get("autoDeploy") == "no",
        "docker_context_matches": runtime.get("dockerContext") in {".", "./"},
        "dockerfile_matches": runtime.get("dockerfilePath")
        in {"Dockerfile", "./Dockerfile"},
        "logs_api_http": log_status,
        "recognized_log_error_categories": log_categories(log_data)
        if isinstance(log_data, dict)
        else [],
        "root_directory_matches": data.get("rootDir") == expected_root,
        "docker_runtime": runtime.get("dockerfilePath") is not None
        or details.get("env") == "docker",
        "health_path_matches": details.get("healthCheckPath") == expected_health
        if role == "backend"
        else None,
        "environment_api_http": env_status,
        "required_environment_nonempty": environment_checks(
            env if isinstance(env, list) else [], required, "envVar"
        ),
        "deployment_api_http": deploy_status,
        "latest_deployment_state": state if state in states else "unknown",
        "latest_deployment_commit": safe_commit(latest.get("commit", {}).get("id")),
        "direct_health_http": health(origin, expected_health)
        if role == "backend"
        else None,
    }


def vercel(expected_root, required):
    token = os.environ.get("VERCEL_TOKEN", "")
    project = os.environ.get("VERCEL_PROJECT_ID", "")
    team = os.environ.get("VERCEL_ORG_ID", "")
    if not token or not re.fullmatch(r"prj_[A-Za-z0-9]+", project):
        return {"configured": False}
    query = "?" + urlencode({"teamId": team}) if team.startswith("team_") else ""
    data, status = get_json(
        "https://api.vercel.com/v9/", "projects/" + project + query, token
    )
    if status != 200:
        return {"api_http": status}
    env, env_status = get_json(
        "https://api.vercel.com/v9/", "projects/" + project + "/env" + query, token
    )
    production_keys = {
        entry.get("key")
        for entry in env.get("envs", [])
        if "production" in entry.get("target", [])
    }
    target = data.get("targets", {}).get("production", {})
    state = target.get("readyState")
    return {
        "api_http": status,
        "root_directory_matches": data.get("rootDirectory") == expected_root,
        "nextjs_framework": data.get("framework") == "nextjs",
        "environment_api_http": env_status,
        "required_production_environment_present": {
            key: key in production_keys for key in required
        },
        "production_state": state
        if state in {"READY", "ERROR", "BUILDING", "QUEUED", "CANCELED"}
        else "unknown",
        "production_commit": safe_commit(target.get("meta", {}).get("githubCommitSha")),
    }


def main():
    portal = os.environ.get("GITHUB_REPOSITORY", "").endswith("/onesa-company-portal")
    backend_root = (
        "onesa-company-portal-backend" if portal else "onesa-ai-platform-backend"
    )
    frontend_root = (
        "onesa-company-portal-frontend"
        if portal
        else "onesa-ai-platform-frontend/apps/chat"
    )
    required = (
        [
            "DATABASE_URL",
            "SESSION_KEY",
            "PUBLIC_ORIGIN",
            "PROXY_SHARED_KEY",
            "S3_BUCKET",
            "S3_ENDPOINT",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
        ]
        if portal
        else [
            "ONESA_DATABASE_URL",
            "ONESA_ENVIRONMENT",
            "ONESA_PUBLIC_ORIGIN",
            "ONESA_MODEL_BACKEND",
            "ONESA_MODEL_NAME",
            "ONESA_MODEL_BASE_URL",
            "ONESA_MODEL_API_KEY",
        ]
    )
    report = {
        "read_only": True,
        "source_commit": safe_commit(os.environ.get("GITHUB_SHA")),
        "backend": render(
            "backend",
            os.environ.get("RENDER_BACKEND_SERVICE_ID", ""),
            required,
            backend_root,
            "/api/v1/ready" if portal else "/core-ready",
        ),
        "frontend": vercel(
            frontend_root,
            [
                "BACKEND_URL",
                "PROXY_SHARED_KEY",
                "SITE_URL",
                "PORTAL_URL",
                "PUBLIC_ORIGIN",
            ]
            if portal
            else ["ONESA_API_URL"],
        ),
    }
    if portal:
        candidates, candidate_status = get_json(
            "https://api.render.com/v1/",
            "services?type=background_worker&limit=100",
            os.environ.get("RENDER_API_KEY", ""),
        )
        worker_ids = []
        if candidate_status == 200 and isinstance(candidates, list):
            for entry in candidates:
                item = entry.get("service", entry)
                identifier = item.get("id", "")
                if (
                    item.get("repo", "").removesuffix(".git").rstrip("/")
                    == "https://github.com/" + os.environ.get("GITHUB_REPOSITORY", "")
                    and item.get("type") == "background_worker"
                    and re.fullmatch(r"srv-[A-Za-z0-9]+", identifier)
                ):
                    worker_ids.append(identifier)
        report["existing_worker_lookup_http"] = candidate_status
        report["matching_existing_worker_ids"] = worker_ids
        report["worker"] = render(
            "worker",
            os.environ.get("RENDER_WORKER_SERVICE_ID", ""),
            [
                "DATABASE_URL",
                "SESSION_KEY",
                "S3_BUCKET",
                "S3_ENDPOINT",
                "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY",
                "MAIL_PROVIDER",
                "RESEND_API_KEY",
                "MAIL_FROM",
            ],
            backend_root,
            "",
        )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
