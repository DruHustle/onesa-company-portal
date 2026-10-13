"""Validate private synthetic fixture inputs without exposing their values."""

import base64
import binascii
import json
import re
from typing import ClassVar


class FixtureError(ValueError):
    CODES: ClassVar[set[str]] = {
        "FIXTURE_JSON",
        "FIXTURE_BINDING",
        "FIXTURE_USERS",
        "FIXTURE_EMAIL",
        "FIXTURE_PASSWORD",
        "FIXTURE_TOTP",
        "FIXTURE_PRODUCT",
    }

    def __init__(self, code):
        self.code = code if code in self.CODES else "FIXTURE_JSON"
        super().__init__(self.code)


def decode_totp(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"[A-Za-z2-7]{16,128}={0,6}", value
    ):
        raise FixtureError("FIXTURE_TOTP")
    normalized = value.upper().rstrip("=")
    try:
        decoded = base64.b32decode(normalized + "=" * (-len(normalized) % 8))
    except (binascii.Error, ValueError):
        raise FixtureError("FIXTURE_TOTP") from None
    if not 10 <= len(decoded) <= 64:
        raise FixtureError("FIXTURE_TOTP")
    return decoded


def parse_fixtures(
    raw, project_id, product, *, scope="approved-synthetic-staging", credentials=True
):
    if product not in {"onesa-company-portal", "onesa-ai-platform"}:
        raise FixtureError("FIXTURE_PRODUCT")
    if not isinstance(raw, str) or not raw or len(raw.encode()) > 16384:
        raise FixtureError("FIXTURE_JSON")
    try:
        config = json.loads(raw)
    except (ValueError, TypeError):
        raise FixtureError("FIXTURE_JSON") from None
    if (
        not isinstance(config, dict)
        or config.get("scope") != scope
        or config.get("project_id") != project_id
    ):
        raise FixtureError("FIXTURE_BINDING")
    users = config.get("users")
    if (
        not isinstance(users, list)
        or len(users) != 2
        or not all(isinstance(user, dict) for user in users)
    ):
        raise FixtureError("FIXTURE_USERS")
    emails = []
    for user in users:
        email = user.get("email")
        if (
            not isinstance(email, str)
            or len(email) > 254
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+\-]*@example\.com", email)
        ):
            raise FixtureError("FIXTURE_EMAIL")
        emails.append(email.casefold())
        if credentials:
            password = user.get("password")
            lower, upper = (14, 256) if product.endswith("portal") else (12, 128)
            if not isinstance(password, str) or not lower <= len(password) <= upper:
                raise FixtureError("FIXTURE_PASSWORD")
            if product.endswith("portal"):
                decode_totp(user.get("totp_secret"))
    if len(set(emails)) != 2:
        raise FixtureError("FIXTURE_USERS")
    return config
