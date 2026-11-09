"""Scan the consolidated Git index and working files with each product's own rules.

Print only file paths and rule identifiers. An explicit product mode supports the
existing independent gates without mistaking an arbitrary parent Git repository
for this reviewed consolidation.
"""

import argparse
import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path, PurePosixPath

from ci.config import IMPORTED_HEADS, PRODUCTS, ROOT


# The exact historical Xcode environment bootstrap is source, not a secret.
# This exception is HISTORY ONLY: current index/worktree policy stays strict.
# Security review: https://github.com/DruHustle/onesa-ug/issues/18
HISTORICAL_XCODE_PATH = "onesa-mobile/onesa-mobile-frontend/mobile/ios/.xcode.env"
HISTORICAL_XCODE_BLOB = "3d5782c71568d32eec2fe71b034efcde053305f9"


def reviewed_historical_xcode_bootstrap(scope, name, data, mode="100644"):
    if (
        not scope.startswith("history:")
        or name != HISTORICAL_XCODE_PATH
        or mode != "100644"
    ):
        return False
    header = b"blob " + str(len(data)).encode("ascii") + b"\0"
    return hashlib.sha1(header + data).hexdigest() == HISTORICAL_XCODE_BLOB


def git(root, *args):
    return subprocess.check_output(
        ["git", "-C", str(root), *args], stderr=subprocess.PIPE
    )


def validate_root(root):
    root = root.resolve()
    if (
        Path(git(root, "rev-parse", "--show-toplevel").decode().strip()).resolve()
        != root
    ):
        raise ValueError("Refusing an inherited ancestor Git repository")
    for product in PRODUCTS.values():
        path = root / product
        scanner = path / "scripts/repository_hygiene.py"
        if (
            path.is_symlink()
            or (path / "scripts").is_symlink()
            or scanner.is_symlink()
            or not scanner.is_file()
            or (path / ".git").exists()
        ):
            raise ValueError("Unexpected consolidated product boundary: " + product)
    return root


def load_rules(root):
    result = {}
    for product in PRODUCTS.values():
        path = root / product / "scripts/repository_hygiene.py"
        spec = importlib.util.spec_from_file_location(
            "hygiene_" + product.replace("-", "_"), path
        )
        module = importlib.util.module_from_spec(spec)
        previous = sys.dont_write_bytecode
        try:
            sys.dont_write_bytecode = True
            spec.loader.exec_module(module)
        finally:
            sys.dont_write_bytecode = previous
        result[product] = module
    return result


def valid_path(name):
    path = PurePosixPath(name)
    return (
        bool(path.parts)
        and not path.is_absolute()
        and str(path) == name
        and not any(part in {".", "..", ".git"} for part in path.parts)
        and not any(ord(character) < 32 for character in name)
    )


def scan(root, product=None, history=False):
    root = validate_root(root)
    if product is not None and product not in PRODUCTS.values():
        raise ValueError("Unknown product boundary")
    rules = load_rules(root)
    findings = []
    blobs = {}

    def blob(oid):
        if oid not in blobs:
            blobs[oid] = git(root, "cat-file", "blob", oid)
        return blobs[oid]

    def inspect(scope, name, data, mode="100644", legacy=None):
        first, separator, relative = name.partition("/")
        owner = legacy or (first if first in rules and separator else None)
        if product is not None and owner != product:
            return
        if not valid_path(name):
            findings.append(
                {"scope": scope, "path": name, "rule": "invalid-source-path"}
            )
            return
        display = (legacy + "/" + name) if legacy else name
        if mode not in {"100644", "100755"}:
            findings.append(
                {"scope": scope, "path": display, "rule": "source-alias-or-gitlink"}
            )
            return
        local_name = name if legacy or owner is None else relative
        selected_rules = [rules[owner]] if owner else list(rules.values())
        detected = set()
        for module in selected_rules:
            if module.denied(local_name) and not reviewed_historical_xcode_bootstrap(scope, name, data, mode):
                detected.add("restricted-or-generated-path")
            detected.update(module.secrets(data, local_name))
        findings.extend(
            {"scope": scope, "path": display, "rule": rule} for rule in sorted(detected)
        )

    for entry in git(root, "ls-files", "--stage", "-z").split(b"\0"):
        if not entry:
            continue
        metadata, raw_name = entry.split(b"\t", 1)
        mode, oid, stage = metadata.decode().split()
        name = raw_name.decode("utf-8", errors="replace")
        if stage != "0":
            findings.append({"scope": "index", "path": name, "rule": "unmerged-index"})
        inspect("index", name, blob(oid) if mode in {"100644", "100755"} else b"", mode)
    names = (
        git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
        .decode()
        .split("\0")
    )
    for name in sorted(set(names) - {""}):
        if not valid_path(name):
            inspect("worktree", name, b"")
            continue
        path = root / name
        if path.is_symlink() or any(
            parent.is_symlink() for parent in path.parents if parent != root
        ):
            inspect("worktree", name, b"", "120000")
        elif path.is_file():
            inspect("worktree", name, path.read_bytes())
    if history:
        selected = [product] if product else list(PRODUCTS.values())
        seen = set()

        def inspect_commit(commit, prefix=None, legacy=None, root_only=False):
            args = ["ls-tree", "-r", "-z", commit]
            if prefix:
                args.extend(["--", prefix])
            for entry in git(root, *args).split(b"\0"):
                if not entry:
                    continue
                metadata, raw_name = entry.split(b"\t", 1)
                mode, kind, oid = metadata.decode().split()
                name = raw_name.decode("utf-8", errors="replace")
                if root_only and name.partition("/")[0] in PRODUCTS.values():
                    continue
                identity = (legacy, name, oid, mode)
                if identity in seen:
                    continue
                seen.add(identity)
                inspect(
                    "history:" + commit[:12],
                    name,
                    blob(oid) if kind == "blob" else b"",
                    mode,
                    legacy,
                )

        # Product-scoped history covers both its original imported ancestry and
        # subsequent monorepo changes, without scanning unrelated products as it.
        for selected_product in selected:
            legacy_head = IMPORTED_HEADS[selected_product]
            git(root, "merge-base", "--is-ancestor", legacy_head, "HEAD")
            for commit in git(root, "rev-list", legacy_head).decode().splitlines():
                inspect_commit(commit, legacy=selected_product)
            for commit in (
                git(root, "rev-list", "--all", "--", selected_product)
                .decode()
                .splitlines()
            ):
                inspect_commit(commit, prefix=selected_product)
        if product is None:
            # Include every root path, including deleted files and consolidation
            # commits before all imports. Legacy ancestor sets were scanned
            # above with their original product policies.
            for commit in (
                git(
                    root,
                    "rev-list",
                    "--all",
                    "--not",
                    *IMPORTED_HEADS.values(),
                )
                .decode()
                .splitlines()
            ):
                inspect_commit(commit, root_only=True)
    return sorted(findings, key=lambda row: (row["scope"], row["path"], row["rule"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--product", choices=PRODUCTS.values())
    parser.add_argument("--history", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    findings = scan(ROOT, args.product, args.history)
    if args.json:
        print(
            json.dumps(
                {
                    "history_scanned": args.history,
                    "product": args.product,
                    "findings": findings,
                },
                indent=2,
            )
        )
    else:
        for row in findings:
            print("{scope}: {path} [{rule}]".format(**row))
        print(
            f"Consolidated publication hygiene: {len(findings)} finding(s); manual review remains required."
        )
    return int(bool(findings))


if __name__ == "__main__":
    raise SystemExit(main())
