#!/usr/bin/env python3
"""Delete only old, unaliased ERROR deployments in an explicit Vercel scope.

Preview is the default. --apply prints the preview before mutation, then rechecks
project ownership, terminal state, failure time, aliases and rollback protection.
READY, CANCELED and unknown states are never deleted. The two-hour threshold plus
an hourly timer leaves retry margin before the 24-hour objective. Provider native
retention alone permits a further 48-hour processing delay.

Use --cli with already authenticated Vercel CLI for owner-run verification, or a
least-privilege token in VERCEL_TOKEN / systemd's vercel-token credential. No token,
provider response body or source metadata is included in receipts. The installed
timer requires separately provisioned credential custody and reviewed source.
"""

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


HOUR = 3_600_000


class Refused(RuntimeError):
    pass


def iso(milliseconds):
    return dt.datetime.fromtimestamp(milliseconds / 1000, dt.timezone.utc).isoformat()


def read_config(path):
    config = json.loads(Path(path).read_text())
    if not re.fullmatch(r"team_[A-Za-z0-9]+", config.get("teamId", "")):
        raise Refused("invalid team scope")
    projects = config.get("projectIds", [])
    if not projects or len(projects) != len(set(projects)) or any(
        not re.fullmatch(r"prj_[A-Za-z0-9]+", value) for value in projects
    ):
        raise Refused("invalid project allowlist")
    return config


class API:
    def __init__(self, team, cli=False):
        self.team = team
        self.cli = cli

    def __call__(self, path, method="GET", **query):
        query["teamId"] = self.team
        endpoint = path + "?" + urllib.parse.urlencode(query)
        if self.cli:
            command = ["vercel", "api", endpoint, "--method", method]
            if method == "DELETE":
                command.append("--dangerously-skip-permissions")
            result = subprocess.run(command, capture_output=True, text=True, timeout=60)
            if result.returncode:
                raise Refused("provider CLI request failed")
            return json.loads(result.stdout)
        token = os.environ.get("VERCEL_TOKEN")
        credential_dir = os.environ.get("CREDENTIALS_DIRECTORY")
        if not token and credential_dir:
            token = (Path(credential_dir) / "vercel-token").read_text().strip()
        if not token:
            raise Refused("provider credential unavailable")
        request = urllib.request.Request(
            "https://api.vercel.com" + endpoint,
            headers={"Authorization": "Bearer " + token}, method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if method == "DELETE" and error.code == 404:
                return {"alreadyAbsent": True}
            raise Refused("provider request failed: HTTP " + str(error.code)) from None
        except urllib.error.URLError:
            raise Refused("provider network unavailable") from None


def pages(api, path, field, **query):
    seen = set()
    cursor = None
    for _ in range(1000):
        data = api(path, **query, **({"until": cursor} if cursor else {}))
        values = data.get(field)
        if not isinstance(values, list):
            raise Refused("invalid provider page")
        for value in values:
            identity = value.get("uid") or value.get("id") or value.get("alias")
            if not identity:
                raise Refused("missing provider identity")
            if identity not in seen:
                seen.add(identity)
                yield value
        following = data.get("pagination", {}).get("next")
        if following is None:
            return
        if not isinstance(following, (int, float)) or (cursor and following >= cursor):
            raise Refused("non-progressing provider pagination")
        cursor = following
    raise Refused("provider pagination limit")


def project_owned(api, project, team):
    data = api("/v9/projects/" + project)
    if data.get("id") != project or data.get("accountId") != team:
        raise Refused("project ownership mismatch")
    return data


def failure_time(deployment):
    # ready is the terminal timestamp, not creation or a later metadata update.
    value = deployment.get("ready")
    created = deployment.get("createdAt", deployment.get("created"))
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not isinstance(created, (int, float)) or value < created):
        return None
    return value


def inspect(api, identifier, project, team, now):
    project_data = project_owned(api, project, team)
    deployment = api("/v13/deployments/" + identifier)
    if deployment.get("id") != identifier:
        raise Refused("deployment identity mismatch")
    actual_project = deployment.get("projectId") or deployment.get("project", {}).get("id")
    if actual_project != project:
        raise Refused("deployment project mismatch")
    state = deployment.get("readyState", deployment.get("state"))
    failed_at = failure_time(deployment)
    result = {"id": identifier, "projectId": project, "state": state,
              "failedAt": iso(failed_at) if failed_at else None,
              "overdue": bool(failed_at and now - failed_at >= 24 * HOUR)}
    if state != "ERROR":
        result["reason"] = "not_error"
    elif failed_at is None or failed_at > now:
        result["reason"] = "unverified_failure_time"
    elif now - failed_at < 2 * HOUR:
        result["reason"] = "retry_grace"
    elif deployment.get("isRollbackCandidate") is True:
        result["reason"] = "rollback_candidate"
    elif any(target.get("id") == identifier for target in project_data.get("targets", {}).values()):
        result["reason"] = "active_target"
    else:
        # Deployment.alias contains desired/historical aliases; the aliases API
        # resolves their current assignment and is the authority for protection.
        aliases = list(pages(api, "/v4/aliases", "aliases", projectId=project, limit=100))
        if any((alias.get("deploymentId") or (alias.get("deployment") or {}).get("id")) == identifier
               for alias in aliases):
            result["reason"] = "assigned_alias"
        else:
            result["reason"] = "eligible"
    return result


def cleanup(api, config, now, apply=False, emit=lambda value: None):
    report = {"observedAt": iso(now), "teamId": config["teamId"],
              "mode": "apply" if apply else "preview", "candidates": [],
              "deleted": [], "alreadyAbsent": [], "protected": [], "errors": [],
              "nextScheduledAttempt": None, "scheduleVerified": False}
    # Complete every project's inventory before any deletion; partial inventory
    # or an ownership mismatch cannot produce a misleading successful cleanup.
    for project in config["projectIds"]:
        project_owned(api, project, config["teamId"])
        for item in pages(api, "/v6/deployments", "deployments", projectId=project, state="ERROR", limit=100):
            identifier = item.get("uid") or item.get("id")
            if not re.fullmatch(r"dpl_[A-Za-z0-9]+", identifier):
                raise Refused("invalid deployment ID")
            record = inspect(api, identifier, project, config["teamId"], now)
            report["candidates" if record["reason"] == "eligible" else "protected"].append(record)
    emit({"preview": report["candidates"], "protected": report["protected"]})
    if apply:
        for candidate in report["candidates"]:
            identifier = candidate["id"]
            try:
                current = inspect(api, identifier, candidate["projectId"], config["teamId"], now)
                if current["reason"] != "eligible" or current["failedAt"] != candidate["failedAt"]:
                    report["protected"].append(current)
                    continue
                delete_failed = False
                try:
                    api("/v13/deployments/" + identifier, method="DELETE")
                except Refused:
                    # The deployment may disappear after our last observation.
                    # CLI errors are not parsed or trusted: scoped provider
                    # readback establishes absence even after an uncertain delete.
                    delete_failed = True
                # Provider readback must confirm removal from the scoped list.
                remaining = list(pages(api, "/v6/deployments", "deployments", projectId=candidate["projectId"], state="ERROR", limit=100))
                if any((item.get("uid") or item.get("id")) == identifier for item in remaining):
                    raise Refused("deletion readback failed")
                report["alreadyAbsent" if delete_failed else "deleted"].append(identifier)
            except (Refused, subprocess.TimeoutExpired):
                report["errors"].append({"id": identifier, "reason": "delete_or_readback_failed"})
    removed = set(report["deleted"] + report["alreadyAbsent"])
    report["overdueCount"] = len({item["id"] for item in report["candidates"] + report["protected"]
                                 if item["overdue"] and item["id"] not in removed})
    report["successful"] = apply and not report["errors"]
    report["retentionObjectiveMet"] = report["successful"] and report["overdueCount"] == 0
    return report


def write_receipt(path, report):
    path = Path(path)
    previous = json.loads(path.read_text()) if path.exists() else {}
    report["lastSuccessfulCleanup"] = (report["observedAt"] if report["successful"]
                                       else previous.get("lastSuccessfulCleanup"))
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as output:
        json.dump(report, output, indent=2)
        output.write("\n")
        temporary = output.name
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--cli", action="store_true")
    args = parser.parse_args()
    try:
        config = read_config(args.config)
        report = cleanup(API(config["teamId"], args.cli), config, int(time.time() * 1000),
                         args.apply, lambda data: print(json.dumps(data), flush=True))
        write_receipt(args.output, report)
        print(json.dumps({key: report[key] for key in ("mode", "deleted", "overdueCount", "successful", "lastSuccessfulCleanup")}))
        return 1 if report["errors"] else 0
    except (Refused, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"successful": False, "errorType": type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
