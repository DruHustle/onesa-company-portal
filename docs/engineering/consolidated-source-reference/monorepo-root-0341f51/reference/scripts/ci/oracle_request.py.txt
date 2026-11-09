"""Publish or validate a fixed capability request; never contact or change a host.

The JSON is request metadata, not proof of GitHub provenance or release approval.
A trusted consumer must independently verify the actual run and artifact before
executing its own reviewed probe bytes. This module supplies no execution route.
"""

import argparse
import hashlib
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from config import REPOSITORY

REPOSITORY_ID = 1444746154
OWNER = "DruHustle"
WORKFLOW_PATH = ".github/workflows/oracle-capability-request.yml"
ALLOWED_REFS = {"refs/heads/dev", "refs/heads/staging", "refs/heads/main"}
OPERATION = "read-only-capability-probe-v1"
# The target-bound executor bytes stay in private custody, outside public Git.
PROBE_SHA256 = "36e5ed6fdf2b5bdf01a37931ad52ecea54d115a4cfa8ffe01432a8f9f310c830"
TTL = timedelta(minutes=15)
MAX_BYTES = 4096
FIELDS = {
    "schema_version", "operation", "repository", "repository_id", "ref",
    "candidate_commit", "workflow_ref", "workflow_sha", "run_id", "run_attempt",
    "actor", "triggering_actor", "probe_sha256", "issued_at", "expires_at",
    "read_only", "release_authorized",
}


class Rejected(ValueError):
    """Only fixed diagnostic codes may leave the CLI."""


def require(condition, code):
    if not condition:
        raise Rejected(code)


def utc_now():
    return datetime.now(timezone.utc)


def instant(value):
    require(type(value) is str and len(value) == 20, "UTC_TIMESTAMP_REQUIRED")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        raise Rejected("UTC_TIMESTAMP_REQUIRED") from None
    require(parsed.strftime("%Y-%m-%dT%H:%M:%SZ") == value, "UTC_TIMESTAMP_REQUIRED")
    return parsed


def validate_identity(value):
    require(value["repository"] == REPOSITORY and type(value["repository"]) is str
            and type(value["repository_id"]) is int
            and value["repository_id"] == REPOSITORY_ID, "REPOSITORY_IDENTITY")
    require(type(value["ref"]) is str and value["ref"] in ALLOWED_REFS, "SOURCE_REF")
    require(type(value["candidate_commit"]) is str
            and re.fullmatch(r"[a-f0-9]{40}", value["candidate_commit"]), "SOURCE_SHA")
    require(type(value["workflow_ref"]) is str
            and value["workflow_ref"] == REPOSITORY + "/" + WORKFLOW_PATH + "@" + value["ref"]
            and type(value["workflow_sha"]) is str
            and value["workflow_sha"] == value["candidate_commit"], "WORKFLOW_IDENTITY")
    require(type(value["run_id"]) is int and 1 <= value["run_id"] < 2**63, "RUN_ID")
    require(type(value["run_attempt"]) is int and value["run_attempt"] == 1,
            "FRESH_DISPATCH_REQUIRED")
    require(type(value["actor"]) is str and value["actor"] == OWNER
            and type(value["triggering_actor"]) is str
            and value["triggering_actor"] == OWNER, "REQUEST_ACTOR")
    return value


def validate_request(value, *, now=None):
    """Validate untrusted decoded JSON, independently of any local CI environment."""
    require(type(value) is dict and set(value) == FIELDS, "REQUEST_FIELDS")
    require(type(value["schema_version"]) is int and value["schema_version"] == 1,
            "REQUEST_VERSION")
    require(value["operation"] == OPERATION and type(value["operation"]) is str,
            "FIXED_OPERATION_REQUIRED")
    validate_identity(value)
    require(type(value["probe_sha256"]) is str and value["probe_sha256"] == PROBE_SHA256,
            "FIXED_PROBE_REQUIRED")
    require(value["read_only"] is True and value["release_authorized"] is False,
            "REQUEST_ONLY_NO_RELEASE_AUTHORITY")
    issued, expiry = instant(value["issued_at"]), instant(value["expires_at"])
    current = now if now is not None else utc_now()
    require(expiry - issued == TTL, "REQUEST_LIFETIME")
    require(issued <= current + timedelta(seconds=30) and current < expiry,
            "REQUEST_EXPIRED_OR_FUTURE")
    return value


def actions_identity(environment):
    """Validate runner context before constructing a request; never infer approval."""
    require(environment.get("GITHUB_ACTIONS") == "true"
            and environment.get("RUNNER_ENVIRONMENT") == "github-hosted"
            and environment.get("RUNNER_OS") == "Linux", "HOSTED_ACTIONS_REQUIRED")
    require(environment.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "MANUAL_DISPATCH_REQUIRED")
    require(environment.get("GITHUB_REPOSITORY") == REPOSITORY
            and environment.get("GITHUB_REPOSITORY_ID") == str(REPOSITORY_ID),
            "ACTIONS_REPOSITORY_IDENTITY")
    require(environment.get("GITHUB_RUN_ATTEMPT") == "1", "FRESH_DISPATCH_REQUIRED")
    run_id = environment.get("GITHUB_RUN_ID", "")
    require(type(run_id) is str and re.fullmatch(r"[1-9][0-9]{0,18}", run_id), "RUN_ID")
    return validate_identity({
        "repository": environment["GITHUB_REPOSITORY"],
        "repository_id": REPOSITORY_ID,
        "ref": environment.get("GITHUB_REF"),
        "candidate_commit": environment.get("GITHUB_SHA"),
        "workflow_ref": environment.get("GITHUB_WORKFLOW_REF"),
        "workflow_sha": environment.get("GITHUB_WORKFLOW_SHA"),
        "run_id": int(run_id),
        "run_attempt": 1,
        "actor": environment.get("GITHUB_ACTOR"),
        "triggering_actor": environment.get("GITHUB_TRIGGERING_ACTOR"),
    })


def create_request(environment, *, now=None):
    identity = actions_identity(environment)
    issued = (now if now is not None else utc_now()).replace(microsecond=0)
    value = {
        **identity,
        "schema_version": 1,
        "operation": OPERATION,
        "probe_sha256": PROBE_SHA256,
        "issued_at": issued.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "expires_at": (issued + TTL).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "read_only": True,
        "release_authorized": False,
    }
    return validate_request(value, now=issued)


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, "DUPLICATE_JSON_FIELD")
        value[key] = item
    return value


def reject_constant(_value):
    raise Rejected("NONFINITE_JSON_VALUE")


def read_request(path, *, now=None):
    with path.open("rb") as stream:
        raw = stream.read(MAX_BYTES + 1)
    require(len(raw) <= MAX_BYTES, "REQUEST_SIZE")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                           parse_constant=reject_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise Rejected("INVALID_REQUEST_JSON") from None
    return validate_request(value, now=now)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--output", type=Path, help="Create request metadata from the current hosted dispatch")
    mode.add_argument("--validate", type=Path, help="Check a request's schema and expiry; does not authenticate it")
    args = parser.parse_args()
    try:
        if args.validate is not None:
            read_request(args.validate)
            print("Request metadata is valid; provenance and execution remain unverified.")
        else:
            value = create_request(os.environ)
            raw = (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()
            require(len(raw) <= MAX_BYTES, "REQUEST_SIZE")
            with args.output.open("xb") as stream:
                stream.write(raw)
            print("Capability request SHA256:", hashlib.sha256(raw).hexdigest())
            print("No host contacted; no release authority issued.")
    except Rejected as error:
        raise SystemExit("Capability request refused: " + str(error)) from None
    except OSError:
        raise SystemExit("Capability request refused: LOCAL_FILE_UNAVAILABLE") from None


if __name__ == "__main__":
    main()
