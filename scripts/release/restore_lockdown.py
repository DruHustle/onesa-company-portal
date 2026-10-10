"""Offline-first lockdown for this task's disposable restored databases only.

This does not reconcile erased records or approve hosted restoration. It invalidates
restored capabilities before any approved synthetic acceptance service can start.
"""
import argparse
import json
import re
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", required=True)
    parser.add_argument("--database", required=True)
    parser.add_argument("--apply-synthetic-lockdown", action="store_true")
    args = parser.parse_args()
    expected = CONTAINER
    if args.container != expected or not re.fullmatch(r"onesa_audit_[0-9]+_restore", args.database):
        raise SystemExit("Refusing any target other than this task's new disposable restore database")
    if not args.apply_synthetic_lockdown:
        raise SystemExit("Explicit synthetic-lockdown switch is required; no changes applied")
    command = ["docker", "exec", "-i", args.container, "psql", "-U", "audit_test", "-d", args.database, "-At", "-v", "ON_ERROR_STOP=1"]
    result = subprocess.check_output(command, input=SQL, text=True)
    checks = [int(value) for value in result.splitlines() if value.isdecimal()]
    if not checks or any(checks):
        raise SystemExit("Restored capability lockdown verification failed")
    print(json.dumps({"result":"PASS", "checks":len(checks), "remaining_active_capabilities":0,
      "scope":"synthetic restore capability invalidation; erased-user/object/unpublication reconciliation and hosted recovery remain BLOCKED"}))


CONTAINER = 'onesa-remediation-portal-db'
SQL = "BEGIN;\nUPDATE sessions SET expires_at=LEAST(expires_at,now());\nUPDATE recovery_tokens SET expires_at=LEAST(expires_at,now());\nUPDATE bounded_transfers SET expires_at=LEAST(expires_at,now());\nUPDATE content SET state='draft' WHERE state='published';\nUPDATE files SET approval='pending' WHERE approval='approved';\nUPDATE jobs SET status='failed',last_error='Restore lockdown: operator reconciliation required' WHERE status IN ('pending','running');\nCOMMIT;\nSELECT count(*) FROM sessions WHERE expires_at>now();\nSELECT count(*) FROM recovery_tokens WHERE expires_at>now();\nSELECT count(*) FROM bounded_transfers WHERE expires_at>now();\nSELECT count(*) FROM content WHERE state='published';\nSELECT count(*) FROM files WHERE approval='approved';\nSELECT count(*) FROM jobs WHERE status IN ('pending','running');\n"

if __name__ == "__main__":
    main()
