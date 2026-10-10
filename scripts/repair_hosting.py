"""Repair existing hosting layout only; no deploy, secrets rotation or resource creation."""

import json
import os
import re
import urllib.error
import urllib.request
from urllib.parse import urlencode

from inspect_hosting import get_json


def write_json(origin, path, token, payload, method):
    request = urllib.request.Request(
        origin + path,
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (urllib.error.URLError, TimeoutError):
        return 0


def configuration(portal, worker):
    root = "onesa-company-portal-backend" if portal else "onesa-ai-platform-backend"
    command = "node dist/src/jobs/worker.js" if worker else "node dist/src/server.js"
    if not portal:
        command = "sh -c 'exec uvicorn app.main:create_app --factory --host 0.0.0.0 --port ${PORT:-8000} --no-proxy-headers --no-access-log --limit-concurrency 128 --timeout-keep-alive 5 --timeout-graceful-shutdown 130'"
    details = {
        "envSpecificDetails": {
            "dockerfilePath": "./Dockerfile",
            "dockerContext": ".",
            "dockerCommand": command,
        }
    }
    if not worker:
        details["healthCheckPath"] = "/api/v1/ready" if portal else "/core-ready"
    return {
        "autoDeployTrigger": "off",
        "branch": "main",
        "rootDir": root,
        "serviceDetails": details,
    }


def repair_render(repo, service, portal, worker=False):
    token = os.environ.get("RENDER_API_KEY", "")
    role = "worker" if worker else "backend"
    if not token or not re.fullmatch(r"srv-[a-zA-Z0-9]+", service):
        return {"role": role, "configured": False}
    base = "https://api.render.com/v1/"
    path = "services/" + service
    data, status = get_json(base, path, token)
    expected = "https://github.com/" + repo
    if (
        status != 200
        or data.get("repo", "").removesuffix(".git").rstrip("/") != expected
    ):
        return {"role": role, "repository_matches": False, "api_http": status}
    if (
        data.get("type") != ("background_worker" if worker else "web_service")
        or data.get("serviceDetails", {}).get(
            "runtime", data.get("serviceDetails", {}).get("env")
        )
        != "docker"
    ):
        return {"role": role, "service_type_matches": False}
    # Disable native auto-deploy before changing settings; promotion is separately gated.
    pause = write_json(base, path, token, {"autoDeployTrigger": "off"}, "PATCH")
    if pause != 200:
        return {"role": role, "disable_auto_deploy_http": pause}
    update = write_json(base, path, token, configuration(portal, worker), "PATCH")
    env, env_status = get_json(base, path + "/env-vars?limit=100", token)
    values = {}
    if env_status == 200 and isinstance(env, list):
        for entry in env:
            item = entry.get("envVar", entry)
            values[item.get("key")] = item.get("value", "")
    changes = {}
    if portal:
        approved = {"S3_BUCKET": "s3-bucket"}
        endpoint = values.get("AWS_ENDPOINT_URL_S3", "")
        if endpoint.startswith("https://") and endpoint.endswith(
            ".storage.c-7.eu-central-1.aws.neon.tech"
        ):
            approved["S3_ENDPOINT"] = endpoint
        for key, value in approved.items():
            if not values.get(key):
                changes[key] = write_json(
                    base, path + "/env-vars/" + key, token, {"value": value}, "PUT"
                )
    # Secret values and existing encryption/proxy/storage credentials are never copied or rotated.
    return {
        "role": role,
        "layout_update_http": update,
        "environment_alias_updates_http": changes,
        "deployment_requested": False,
    }


def repair_vercel(repo, portal):
    token = os.environ.get("VERCEL_TOKEN", "")
    project = os.environ.get("VERCEL_PROJECT_ID", "")
    team = os.environ.get("VERCEL_ORG_ID", "")
    if not token or not re.fullmatch(r"prj_[A-Za-z0-9]+", project):
        return {"configured": False}
    base = "https://api.vercel.com/v9/"
    query = "?" + urlencode({"teamId": team}) if team.startswith("team_") else ""
    path = "projects/" + project
    data, status = get_json(base, path + query, token)
    link = data.get("link", {})
    if (
        status != 200
        or str(link.get("org", "")) + "/" + str(link.get("repo", "")) != repo
    ):
        return {"repository_matches": False, "api_http": status}
    env, env_status = get_json(base, path + "/env" + query, token)
    if env_status != 200:
        return {"environment_api_http": env_status}
    keys = {
        entry.get("key")
        for entry in env.get("envs", [])
        if "production" in entry.get("target", [])
    }
    changes = {}
    if portal:
        for key, value in {
            "SITE_URL": "https://onesa.eu",
            "PORTAL_URL": "https://portal.onesa.eu",
            "PUBLIC_ORIGIN": "https://portal.onesa.eu",
        }.items():
            if key not in keys:
                changes[key] = write_json(
                    base,
                    path + "/env" + query,
                    token,
                    {
                        "key": key,
                        "value": value,
                        "type": "plain",
                        "target": ["production"],
                    },
                    "POST",
                )
    # Do not derive or publish a new backend URL until direct health and its identity are qualified.
    return {"public_origin_updates_http": changes, "deployment_requested": False}


def main():
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if (
        repo not in {"DruHustle/onesa-company-portal", "DruHustle/onesa-ai-platform"}
        or os.environ.get("GITHUB_REF") != "refs/heads/main"
    ):
        raise SystemExit(
            "Configuration repair requires the approved application repository on main"
        )
    portal = repo.endswith("/onesa-company-portal")
    report = {
        "backend": repair_render(
            repo, os.environ.get("RENDER_BACKEND_SERVICE_ID", ""), portal
        ),
        "frontend": repair_vercel(repo, portal),
    }
    if portal:
        report["worker"] = repair_render(
            repo, os.environ.get("RENDER_WORKER_SERVICE_ID", ""), True, True
        )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
