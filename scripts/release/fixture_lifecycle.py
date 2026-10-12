"""Create/revoke temporary identities only in the verified isolated staging database.

Passwords and authenticator secrets travel through private pipes/files, never logs,
workflow arguments, uploaded artifacts or repository secrets. Existing users are kept.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import timedelta
from pathlib import Path

from evidence import PRODUCT, REPOSITORY, ROOT, require
from fixtures import parse_fixtures
from hosted import preflight


def context():
    require(
        os.environ.get("GITHUB_REPOSITORY") == REPOSITORY
        and os.environ.get("GITHUB_REF") == "refs/heads/staging"
        and os.environ.get("GITHUB_ACTOR") == "DruHustle"
        and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
        and os.environ.get("STAGING_FIXTURE_MODE") == "temporary"
        and re.fullmatch(r"\d{1,20}", os.environ.get("GITHUB_RUN_ID", "")),
        "Temporary fixtures require the owner-dispatched hosted staging candidate",
    )
    return preflight()


def file_path():
    return Path(os.environ["RUNNER_TEMP"], "onesa-private-staging-fixtures.json")


def validate_owned(config):
    require(
        config.get("candidate_commit") == os.environ["GITHUB_SHA"]
        and config.get("run_id") == os.environ["GITHUB_RUN_ID"],
        "Temporary fixture candidate mismatch",
    )
    pattern = r"release-audit-" + config["run_id"] + r"-[a-f0-9]{24}@example\.com"
    require(
        len(config.get("users", [])) == 2
        and all(
            re.fullmatch(pattern, user.get("email", ""))
            and re.fullmatch(r"[a-f0-9-]{36}", user.get("id", ""))
            for user in config["users"]
        ),
        "Temporary fixture ownership mismatch",
    )


def portal(action, config, settings):
    # Only application configuration crosses the private pipe/process boundary.
    env = dict(os.environ)
    for key in [
        "DATABASE_URL",
        "SESSION_KEY",
        "PUBLIC_ORIGIN",
        "PROXY_SHARED_KEY",
        "S3_BUCKET",
        "S3_ENDPOINT",
        "AWS_ENDPOINT_URL_S3",
        "NODE_ENV",
    ]:
        if key in settings:
            env[key] = settings[key]
    result = subprocess.run(
        ["node", "--import", "tsx", "src/auth/staging-fixtures.ts", action],
        cwd=ROOT / "onesa-company-portal-backend",
        env=env,
        input=json.dumps(config),
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    require(result.returncode == 0, "Temporary Portal fixture operation failed")
    return json.loads(result.stdout)


def platform(action, config, settings):
    sys.path.insert(0, str(ROOT / "onesa-ai-platform-backend"))
    import secrets
    from uuid import UUID

    from app.models import AccessGrant, AuthSession, User, now
    from argon2 import PasswordHasher
    from sqlalchemy import create_engine, delete, select, text, update
    from sqlalchemy.engine import make_url
    from sqlalchemy.orm import Session

    url = make_url(settings["ONESA_DATABASE_URL"]).set(drivername="postgresql+psycopg")
    query = dict(url.query)
    query.update(sslmode="verify-full", channel_binding="require")
    engine = create_engine(
        url.set(query=query),
        pool_size=1,
        max_overflow=0,
        connect_args={"connect_timeout": 10, "prepare_threshold": None},
    )
    try:
        with engine.connect() as connection, connection.begin():
            connection.execute(text("SET TRANSACTION READ ONLY"))
            connection.execute(text("SET LOCAL statement_timeout='10s'"))
            identity = connection.execute(
                text("SELECT current_database(),current_user")
            ).one()
            require(
                tuple(identity) == ("neondb", "onesa_ai_staging_app"),
                "Temporary fixture database login mismatch",
            )
            unsafe = connection.scalar(
                text(
                    "SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR has_schema_privilege(current_user,'public','CREATE') OR has_table_privilege(current_user,'public.alembic_version','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) FROM pg_roles WHERE rolname=current_user"
                )
            )
            require(unsafe is False, "Temporary fixture database role unsafe")
            from alembic.config import Config
            from alembic.script import ScriptDirectory

            cfg = Config(str(ROOT / "onesa-ai-platform-backend/alembic.ini"))
            cfg.set_main_option(
                "script_location", str(ROOT / "onesa-ai-platform-backend/migrations")
            )
            head = ScriptDirectory.from_config(cfg).get_current_head()
            require(
                connection.scalar(text("SELECT version_num FROM alembic_version"))
                == head,
                "Temporary fixture schema revision mismatch",
            )
        with Session(engine) as db:
            if action == "create":
                accounts = []
                for _ in range(2):
                    password = secrets.token_urlsafe(32)
                    email = (
                        "release-audit-"
                        + config["run_id"]
                        + "-"
                        + secrets.token_hex(12)
                        + "@example.com"
                    )
                    user = User(
                        email=email,
                        display_name="Synthetic staging verification",
                        password_hash=PasswordHasher().hash(password),
                    )
                    db.add(user)
                    db.flush()
                    db.add(
                        AccessGrant(
                            user_id=user.id, expires_at=now() + timedelta(hours=2)
                        )
                    )
                    accounts.append(
                        {"id": str(user.id), "email": email, "password": password}
                    )
                db.commit()
                return accounts
            validate_owned(config)
            for account in config["users"]:
                user = db.scalar(
                    select(User).where(
                        User.id == UUID(account["id"]), User.email == account["email"]
                    )
                )
                require(user is not None, "Temporary fixture identity mismatch")
                user.status = "disabled"
                db.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
                db.execute(
                    update(AccessGrant)
                    .where(AccessGrant.user_id == user.id)
                    .values(expires_at=now())
                )
            db.commit()
            return {}
    finally:
        engine.dispose()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["create", "cleanup"])
    args = parser.parse_args()
    path = file_path()
    if args.action == "cleanup" and not path.exists():
        return
    require(
        args.action != "create" or not path.exists(),
        "Temporary fixture file already exists",
    )
    verified = context()
    if args.action == "create":
        # The existing owner-approved synthetic scope/project binding grants test scope.
        config = parse_fixtures(
            os.environ["STAGING_FIXTURES_JSON"],
            os.environ["VERCEL_PROJECT_ID"],
            PRODUCT,
            credentials=False,
        )
        config = {
            "scope": config["scope"],
            "project_id": config["project_id"],
            "candidate_commit": os.environ["GITHUB_SHA"],
            "run_id": os.environ["GITHUB_RUN_ID"],
        }
    else:
        config = json.loads(path.read_text())
        validate_owned(config)
    operation = portal if PRODUCT.endswith("portal") else platform
    users = operation(args.action, config, verified["settings"])
    if args.action == "create":
        config["users"] = users
        validate_owned(config)
        parse_fixtures(json.dumps(config), config["project_id"], PRODUCT)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            json.dump(config, handle)
        print("Temporary staging fixtures created; credentials retained privately")
    else:
        path.unlink()
        print("Temporary staging fixtures disabled and sessions revoked")


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 -- Last CLI boundary must redact arbitrary private DB/provider errors.
        # SQL, subprocess and provider exceptions can include credential-bearing values.
        raise SystemExit(
            "Temporary staging fixture operation blocked; no private values logged"
        ) from None
