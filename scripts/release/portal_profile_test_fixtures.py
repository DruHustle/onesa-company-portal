"""Immutable public test inputs for the previously reviewed frontend profiles.

The company billing frontend and current catalog labels are different release
scopes. These bundled fixtures
retain the original public bytes without changing a production pin or requiring
a network or Git-history read. Missing fixtures are an error, never permission to
substitute current or caller-selected source.
"""

import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures/portal_frontend_v1"
# Original source provenance: onesa-ug commit
# 7a63d946688f705b56823b261272d26434981d32, Portal subtree. The history-preserving
# split retains these exact blobs even though commit IDs and paths have changed.
# Their bundled copies also support API-published snapshots without that ancestry.
PREFIX = "onesa-company-portal-frontend/"
# Previously pinned files changed by the separate billing and catalog source.
# Sizes and hashes identify actual original public bytes, not a generated mock.
REVIEWED_FILES = {
    PREFIX + "package.json": (3038, "e3cbc621f1713824ec3f621588ac0d13e0c3cd6d6c7688e7d64dfe85aa00774e"),
    PREFIX + "src/app/api/v1/[...path]/route.ts": (5293, "7fbb4b327152af662956b0f2410c204349874ec7bda59bd6ac60f81dbb158794"),
    PREFIX + "src/features/account/account.tsx": (20006, "e2352fc9b926dece9de5262f6e1fe02890ceeeb09aa081c598e088a8681027c1"),
    PREFIX + "src/features/account/api.ts": (2309, "b5c768285ed6bfcb68999b48c725a958c0625388da0e87548e6d06cca4ead77f"),
    PREFIX + "src/lib/api/generated/schema.d.ts": (787032, "e84ad11bf072ba1c2aee94b70af9ea73e98d8dea426979d55e09479d23cf37f8"),
}
REVIEWED_BLOBS = {
    PREFIX + "package.json": "63c3ba4fafad01f84071c7590034710017d7f2b5",
    PREFIX + "src/app/api/v1/[...path]/route.ts": "5271c8e0089adc388805172f47a955787a856be8",
    PREFIX + "src/features/account/account.tsx": "5aec07bad5bfbc5383c0fc7b0088359360aa908a",
    PREFIX + "src/features/account/api.ts": "7268598ce90253c1b4c350f2e9ac4c947e16edcf",  # gitleaks:allow -- Git blob ID of immutable public source fixture.
    PREFIX + "src/lib/api/generated/schema.d.ts": "1492ca47347c04ccb2d6b3fc439d2f09f3e40c75",
}


def reviewed_frontend_bytes(name):
    if name not in REVIEWED_FILES:
        raise ValueError("UNREVIEWED_LEGACY_TEST_FIXTURE_PATH")
    size, digest = REVIEWED_FILES[name]
    try:
        with (FIXTURE_ROOT / (REVIEWED_BLOBS[name] + ".fixture")).open("rb") as stream:
            data = stream.read(size + 1)
    except OSError as exc:
        raise ValueError("LEGACY_TEST_FIXTURE_UNAVAILABLE") from exc
    if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("LEGACY_TEST_FIXTURE_BYTES_CHANGED")
    return data
