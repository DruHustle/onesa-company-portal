"""Offline-first lockdown for this task's disposable restored databases only.

The legacy synthetic mode only invalidates restored capabilities. The optional
reviewed-ledger mode also reconciles erasures in a labeled, network-isolated copy.
Neither mode authorizes hosted restoration or proves that a ledger is complete.
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
    parser.add_argument("--replay-ledger")
    parser.add_argument("--apply-isolated-replay", action="store_true")
    args = parser.parse_args()
    if args.replay_ledger:
        import restore_replay

        print(
            json.dumps(
                restore_replay.run(
                    args.container,
                    args.database,
                    args.replay_ledger,
                    args.apply_isolated_replay,
                    SQL,
                )
            )
        )
        return
    expected = CONTAINER
    if args.container != expected or not re.fullmatch(
        r"onesa_audit_[0-9]+_restore", args.database
    ):
        raise SystemExit(
            "Refusing any target other than this task's new disposable restore database"
        )
    if not args.apply_synthetic_lockdown:
        raise SystemExit(
            "Explicit synthetic-lockdown switch is required; no changes applied"
        )
    command = [
        "docker",
        "exec",
        "-i",
        args.container,
        "psql",
        "-U",
        "audit_test",
        "-d",
        args.database,
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
    ]
    result = subprocess.check_output(command, input=SQL, text=True)
    checks = [int(value) for value in result.splitlines() if value.isdecimal()]
    if not checks or any(checks):
        raise SystemExit("Restored capability lockdown verification failed")
    print(
        json.dumps(
            {
                "result": "PASS",
                "checks": len(checks),
                "remaining_active_capabilities": 0,
                "scope": "synthetic restore capability invalidation; erased-user/object/unpublication reconciliation and hosted recovery remain BLOCKED",
            }
        )
    )


CONTAINER = "onesa-remediation-portal-db"
SQL = "BEGIN;\nUPDATE sessions SET expires_at=LEAST(expires_at,now());\nUPDATE recovery_tokens SET expires_at=LEAST(expires_at,now());\nUPDATE bounded_transfers SET expires_at=LEAST(expires_at,now());\nUPDATE content SET state='draft' WHERE state='published';\nUPDATE files SET approval='pending' WHERE approval='approved';\nUPDATE jobs SET status='failed',last_error='Restore lockdown: operator reconciliation required' WHERE status IN ('pending','running');\nCOMMIT;\nSELECT count(*) FROM sessions WHERE expires_at>now();\nSELECT count(*) FROM recovery_tokens WHERE expires_at>now();\nSELECT count(*) FROM bounded_transfers WHERE expires_at>now();\nSELECT count(*) FROM content WHERE state='published';\nSELECT count(*) FROM files WHERE approval='approved';\nSELECT count(*) FROM jobs WHERE status IN ('pending','running');\n"

# Optional additive schema: old snapshots may predate Engineering Docs identities.
# This is executed only after the existing isolated-target authority checks.
ENGINEERING_SQL = """DO $engineering$ BEGIN
 IF to_regclass('public.engineering_memberships') IS NOT NULL
 OR to_regclass('public.engineering_identity_records') IS NOT NULL
 OR to_regclass('public.engineering_email_challenges') IS NOT NULL THEN
  IF to_regclass('public.engineering_memberships') IS NULL
  OR to_regclass('public.engineering_identity_records') IS NULL
  OR to_regclass('public.engineering_email_challenges') IS NULL THEN
   RAISE EXCEPTION 'Incomplete restored engineering identity schema';
  END IF;
  UPDATE public.engineering_memberships SET enabled=false;
  DELETE FROM public.engineering_identity_records;
  DELETE FROM public.engineering_email_challenges;
  IF EXISTS(SELECT 1 FROM public.engineering_memberships WHERE enabled)
  OR EXISTS(SELECT 1 FROM public.engineering_identity_records)
  OR EXISTS(SELECT 1 FROM public.engineering_email_challenges) THEN
   RAISE EXCEPTION 'Restored engineering identity remains active';
  END IF;
 END IF;
END $engineering$;
"""
ACCESS_SQL = """DO $access$ BEGIN
 IF to_regclass('public.access_links') IS NOT NULL
 OR to_regclass('public.access_registrations') IS NOT NULL
 OR to_regclass('public.engineering_credentials') IS NOT NULL THEN
  IF to_regclass('public.access_links') IS NULL
  OR to_regclass('public.access_registrations') IS NULL
  OR to_regclass('public.engineering_credentials') IS NULL THEN
   RAISE EXCEPTION 'Incomplete restored access registration schema';
  END IF;
  DELETE FROM public.access_links;
  IF EXISTS(SELECT 1 FROM public.access_links) THEN
   RAISE EXCEPTION 'Restored sign-in links remain active';
  END IF;
 END IF;
END $access$;
"""
SQL = SQL.replace("COMMIT;", ENGINEERING_SQL + ACCESS_SQL + "COMMIT;", 1)

if __name__ == "__main__":
    main()
