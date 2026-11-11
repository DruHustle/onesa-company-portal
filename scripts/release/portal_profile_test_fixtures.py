"""Immutable public test inputs for the previously reviewed frontend profiles.

The company billing frontend and current catalog/browser labels are different release
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
# Public fixtures retain the reviewed bytes before billing, catalog and directory updates.
# The browser fixture comes from Portal ecc4521dc44dd9e162701a5e34a455f7f27661fc.
# Portal 25eef94002d43f8732346308a2b10246adee12f0 and
# f44dee4ef2c3c7ada580e37647fce463dc319970 contain identical footer and product-view blobs.
# Sizes and hashes identify actual original public bytes, not a generated mock.
# Additional historical identity inputs are the exact bytes at Portal 2686929ba0a8e1491dd45734bf4156c46eeebb7e.
REVIEWED_FILES = {
    PREFIX + "src/features/engineering/sign-in.tsx": (16421, "2c69fe4bc96f695561d8a38493dedd8892bee85e6e2fb218a8db25ab078c7499"),
    PREFIX + "src/lib/engineering-sign-in-errors.ts": (3177, "cef6efc4fbad3cb04e67f712ccccc50e57b31827aa55c65262af2e1dfababe6d"),
    PREFIX + "src/lib/onesa-identity.ts": (1755, "18d247125da88f2284faaf4075503e508fc62b8e154b0ef4b6ef795e6d29cac8"),
    PREFIX + "unit/onesa-identity.test.ts": (3072, "4005525a4cd4b5dc34cb402d12ea8842c6f24e8e6ffc7b2ac5d70e195024e112"),
    PREFIX + "src/components/site-footer.tsx": (2925, "aee902a898185551b5d7abb3ff511a57b9a84a30ff1e372919d2146366ce284d"),
    PREFIX + "src/components/product-overview.tsx": (8843, "8ccf113f761c363933f64c0d7f611d199eda8849e23a70bba2d6d0c2f8ce615f"),
    PREFIX + "package.json": (3038, "e3cbc621f1713824ec3f621588ac0d13e0c3cd6d6c7688e7d64dfe85aa00774e"),
    PREFIX + "scripts/test-onesa-account.mjs": (43775, "fdd380ccad7ebef858697155c0cd235e8d62d824d54dafcea6ac3edaa24a63e0"),
    PREFIX + "src/app/api/v1/[...path]/route.ts": (5293, "7fbb4b327152af662956b0f2410c204349874ec7bda59bd6ac60f81dbb158794"),
    PREFIX + "src/features/account/account.tsx": (20006, "e2352fc9b926dece9de5262f6e1fe02890ceeeb09aa081c598e088a8681027c1"),
    PREFIX + "src/features/account/api.ts": (2309, "b5c768285ed6bfcb68999b48c725a958c0625388da0e87548e6d06cca4ead77f"),
    PREFIX + "src/lib/api/generated/schema.d.ts": (787032, "e84ad11bf072ba1c2aee94b70af9ea73e98d8dea426979d55e09479d23cf37f8"),
}
REVIEWED_BLOBS = {
    PREFIX + "src/features/engineering/sign-in.tsx": "ed871e21ef90c4be1e214cc3d1a75a968216cb76",
    PREFIX + "src/lib/engineering-sign-in-errors.ts": "3f024f195f0a8fcb8432d5629b3b231c88d2606b",
    PREFIX + "src/lib/onesa-identity.ts": "9388e8e4b3f558ef3955d2624f55dc318d861848",
    PREFIX + "unit/onesa-identity.test.ts": "593595d58cc313a3c4be2c10e3e743e76081446f",
    PREFIX + "src/components/site-footer.tsx": "117a384565a5855fe103253f962b3d8fe2aefda4",
    PREFIX + "src/components/product-overview.tsx": "edd985c57114704bba320b1679937b702047abb6",
    PREFIX + "package.json": "63c3ba4fafad01f84071c7590034710017d7f2b5",
    PREFIX + "scripts/test-onesa-account.mjs": "f3f5cdd4021be407c03368b7e20c09a12a318a3b",
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
