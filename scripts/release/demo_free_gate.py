"""Local synthetic demonstration only: no GitHub write or provider deployment."""

import json
from unittest.mock import patch

import evidence as e
import free_gate as f
from test_evidence import FINGERPRINT, SHA
from test_free_gate import GitHub


def main():
    github = GitHub()
    with patch.object(e, "source_hash", return_value=FINGERPRINT):
        github.record = f.qualification(github, SHA, github.run(30), 20)
        fingerprint = e.digest(github.record)
        github.issue["body"] = (
            SHA
            + " "
            + fingerprint
            + " OPERATIONS_APPROVED CONTENT_LEGAL_APPROVED EXTERNAL_PRODUCTION_CONTROLS_VERIFIED"
        )
        github.approval = f.authorize(
            github, SHA, github.run(40), 30, fingerprint, 2, "approve"
        )
        positive = f.verify(github, SHA, 40)["status"]
        github.ci_jobs[0]["conclusion"] = "failure"
        try:
            f.verify(github, SHA, 40)
        except e.Rejected as error:
            denial = str(error)
        else:
            raise SystemExit("Regression: failing CI was authorized")
    print(
        json.dumps(
            {
                "scope": "local synthetic API responses; real gate functions",
                "passing_ci": positive,
                "failing_ci": "BLOCKED",
                "reason": denial,
                "provider_calls": 0,
                "remote_write": False,
                "git_push_blocked": False,
                "physical_hardware_authorized": False,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
