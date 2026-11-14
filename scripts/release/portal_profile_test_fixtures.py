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
# The historical access manager is preserved verbatim from Portal f104f81.
# The historical Admin screen is also from f104f81, before infrastructure monitoring.
# Additional shared-entry predecessors are public blobs from Portal a746c55e.
# The standalone Admin entry and original routing proxy come from Portal 9e8c939a.
# Portal 550e007e retains the original domain routing helper.
# Catalog predecessor is the public blob at Portal 473d5b1b2b80.
REVIEWED_FILES = {
    PREFIX + "src/config/onesa-applications.json": (371, "0eeccc055f8d6df8662f0763453932e5d55dd5be9530a45a4cd863962f01e635"),  # gitleaks:allow -- historical public catalog SHA-256.
    PREFIX + "src/lib/domains.ts": (2553, "9cc261a9580b01ffa7215c4db10b6b8ece118e913e06fa4f3f815f0c77916447"),
    PREFIX + "src/proxy.ts": (2917, "01acb9084f2d2af5610a723896602b1578b83baa59c0fa8e55b0e31add46955f"),
    PREFIX + "src/app/admin/page.tsx": (546, "163d7517e01aee14108a335aaf1594fc4d140ddff649966621d75130543fcb1f"),
    PREFIX + "public/brand/sources.json": (34382, "feacf92edbd620e3c86af5546a5eb7f0df6423af389eb568f1b29735cd3c5e8c"),
    PREFIX + "src/app/account/sign-in/[uid]/page.tsx": (322, "487659424b193ee47164c7c8e9732d63da685db1d2fa309f6a79c55b0b10d5f4"),
    PREFIX + "scripts/test-engineering-sign-in.mjs": (55610, "33b6b31a69763986837b3a902328534404e6ceb56ea3e33bb86a9068b85afd1c"),
    PREFIX + "src/app/access/register/page.tsx": (595, "fe8918cfa167c6efd48e006f680c63c73fdbe25f2315780b79f648d36774169c"),
    PREFIX + "src/app/account/confirm/page.tsx": (137, "7a5d4935e7c1e36b643f72acc1ea0d3f9e47708e5ce14b2e2536e70a86d8fa21"),
    PREFIX + "src/app/account/page.tsx": (122, "5a8e96097730cc9ac1495c85e65ac7cf35d48d36cbbebaca38ab5811ae63ed58"),
    PREFIX + "src/app/account/register/page.tsx": (138, "cb3486c1924d1809bdef9ca25940342ad54ad815ce1f9ad3e90691d9084a6787"),
    PREFIX + "src/app/account/security/page.tsx": (130, "665df823dc94eb83a0b66874ff60250476657c247890893c1cf709bc549f733e"),
    PREFIX + "src/features/access/authenticator-setup.tsx": (7258, "ba6325d91c1e839f2cf162eb8cdd6a56a32914f538ec7244209bc02cf819cb86"),
    PREFIX + "src/features/account/account.module.css": (4659, "d8505f9ea39cb9e505e7c6285c308947d77594c47a167cb709ce6d2880d06ad9"),
    PREFIX + "src/features/account/security.tsx": (7231, "bbdeb339758445978c49ae30345424ee487a45e6003617a35de6e59a1102bf83"),
    PREFIX + "src/lib/account-return.ts": (1482, "5094d6ce4bcd29bc05f7d1bc0b6f73666af6406eb6a7b1094f363e1a973a9043"),
    PREFIX + "unit/account-return.test.ts": (2734, "10a0af98ef261f9b282d039b4a210c8701c6be2ee15b7cf415857dd8380cfa5f"),
    PREFIX + "src/features/admin/portal.tsx": (67332, "deeb9722ccf7434a2835e24f9e2425ea2fcab7c32a46da9dc0306a7621fdcd6e"),
    PREFIX + "src/features/account/access-manager.tsx": (11966, "24400fcf47357b6e7951a40a36bf3b9c5e28ac6c97099cd837cfe0fe3471f6d4"),
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
    PREFIX + "src/config/onesa-applications.json": "50b6a2d05073665da4f3908aaca8c969576a842b",
    PREFIX + "src/lib/domains.ts": "1f8a8db0addb2f3cb52a3cf6735a1cb501cc77f4",
    PREFIX + "src/proxy.ts": "5b9eea107d3199433b5e98b7db76674ba400fd17",
    PREFIX + "src/app/admin/page.tsx": "b630ba8e08e5849d8eaf5d311d099dff6a8f12e7",
    PREFIX + "public/brand/sources.json": "655eca043d51594e4be4165b8555a047cf0f5adc",
    PREFIX + "src/app/account/sign-in/[uid]/page.tsx": "6b10afd5bf15ac1db29eda8e4081530edc9688cf",
    PREFIX + "scripts/test-engineering-sign-in.mjs": "77e37248f103438cd06cd2a5d58cbdd836b997de",
    PREFIX + "src/app/access/register/page.tsx": "fabdc98f4f2434cb9c67cd17a4718e084151f2b1",
    PREFIX + "src/app/account/confirm/page.tsx": "9a5070ea2ae63a7118c9337045f2d7e5d36a6646",
    PREFIX + "src/app/account/page.tsx": "6776558fa1264785b071e829c608639aee3f6ec6",
    PREFIX + "src/app/account/register/page.tsx": "3da937d2e3d9c018f68e64625c6d1c05a4f25e7b",
    PREFIX + "src/app/account/security/page.tsx": "e9b32d9282fa6708bba8e9a36f3be08a74e7a44f",
    PREFIX + "src/features/access/authenticator-setup.tsx": "20f909f78ea1643f8b2f4a1b16f3618a363a2089",  # gitleaks:allow -- Git blob ID of immutable public source fixture.
    PREFIX + "src/features/account/account.module.css": "bd9d7b06600c5c67280ba91795584be3d354f109",
    PREFIX + "src/features/account/security.tsx": "e60235b1d98b12f66c65653e639d3aa70fde99ba",
    PREFIX + "src/lib/account-return.ts": "e7c21407031de4becde6c01cf71c83dcf26906b7",
    PREFIX + "unit/account-return.test.ts": "05660c3945eeda53fd154801a931f773ae8d5ea1",
    PREFIX + "src/features/admin/portal.tsx": "78ff42da23691e12c28be6ac4439d1cb694213db",
    PREFIX + "src/features/account/access-manager.tsx": "f84c3503551a5897befac16730895a59bd26effb",  # gitleaks:allow -- Git blob of the reviewed public access manager.
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


# Historical positive inputs for the schema-016 release and restore fixtures.
# Exact migration bytes at Portal f104f81ef25a4b75d9f8fbf803021db82caa047b.
SCHEMA_016 = {
    "001_initial.sql": "7d9b7ee898859ec4cd858f9cba4e43bc7c62a866323ca6786d2d7571cf4e26e9",
    "002_security_workflows.sql": "f4900254857995fd7da68ad51f2f5728ad2376213aad4d943a1ffc5ee8ab8fec",
    "003_document_versions.sql": "f6e0bf91cb2f547754d7eaafbe38e28edc563b25101e3d7878beb9f901e42b15",
    "004_company_facts.sql": "49d4d0bb74ae099104e45a6007a974d0ad12423aff49af23b4c28fc5d6385aa9",
    "005_storage_deletion_outbox.sql": "ea8c603df94c9310177f4af9d15ac41be16b4f1d5ca1e36508509e771f94f563",
    "006_bounded_transfers.sql": "da997d58639f6dd6e6eac5cf5a845e59422b1a96e2e0f4ba6b38c4d84ce111be",
    "007_operational_state.sql": "f1c27cd7ada57de2b262feb67e6c8290419b27e8094754ed01ca3ebed4ea76ea",
    "008_privacy_governance.sql": "c016c076686dfcb2982c743359ad94bfa24fca71bc1250e20fc3b7c655df02e3",
    "009_privacy_lifecycle.sql": "8d066d911d17dd5aec1cc89915037bfb5f158afa069e381e4fb42976348877a5",
    "010_engineering_identity.sql": "11f4cb0d0fb2de052c31583a35d72b68f4ed288b155196e6cee9cf56010f5c86",
    "011_access_registration.sql": "11ee7bd502a78ee876f1634edf34dc626d3a3b9c7417646427abe03607e0e297",  # gitleaks:allow -- SHA-256 of immutable public migration SQL.
    "012_editorial_publications.sql": "8da498b00c9eef6e9cdd4bf4299d2ffa7a890e5d936fc23c6f37e9398b54608c",
    "013_onesa_identity.sql": "ce7f4ab09f7fafb915b4a4e8b1657ef1e6520494bd28a0492fc3d46d0f4d79e7",
    "014_identity_grant_sessions.sql": "a45640fc7a946f410033c0cc9cd666bfcb2e6a8e02a4f5a200bc2b548f7ce03f",
    "015_mobile_identity.sql": "424c55596b0a3ee98330a2b2cd9171ab9dd2b23b8b20961a5f4b16b59f9867df",
    "016_engineering_account_links.sql": "37416e013033aedfc54478f569ccc2b0eb8b0bf67e32bc76e13ae4fec24b5577",
}


def schema_016_migrations(root):
    directory = root / "onesa-company-portal-backend/migrations"
    migrations = {}
    for name, digest in SCHEMA_016.items():
        data = (directory / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError("HISTORICAL_MIGRATION_BYTES_CHANGED")
        migrations[name] = data
    return migrations
