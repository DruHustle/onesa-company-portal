"""Run unchanged product security policy in its original Git-root namespace.

Actionlint resolves reusable workflows against the nearest Git root. Product
deployment workflows are retained as source inputs, so check them in a disposable
source export without making them active root deployment workflows.
"""

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath

from config import PRODUCTS, ROOT


def export_product(destination, key, root=ROOT):
    source_root = root / PRODUCTS[key]
    actual = subprocess.check_output(
        ["git", "-C", str(source_root), "rev-parse", "--show-toplevel"], text=True
    ).strip()
    if Path(actual).resolve() != root.resolve() or source_root.is_symlink():
        raise ValueError("Expected consolidated product source boundary")
    names = (
        subprocess.check_output(
            [
                "git",
                "-C",
                str(source_root),
                "ls-files",
                "-c",
                "-o",
                "--exclude-standard",
                "-z",
            ]
        )
        .decode()
        .split("\0")
    )
    target_root = destination / PRODUCTS[key]
    target_root.mkdir()
    for name in sorted(set(names) - {""}):
        relative = PurePosixPath(name)
        if (
            relative.is_absolute()
            or str(relative) != name
            or any(part in {"..", ".git"} for part in relative.parts)
            or any(ord(character) < 32 for character in name)
        ):
            raise ValueError("Noncanonical product source path")
        source = source_root / name
        if any(path.is_symlink() for path in (source, *source.parents)):
            raise ValueError("Product source aliases require review")
        if source.is_file():
            target = target_root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
    subprocess.run(["git", "init", "--quiet", str(target_root)], check=True)
    subprocess.run(
        ["git", "-C", str(target_root), "add", "--force", "--all"], check=True
    )
    subprocess.run(
        [
            "git",
            "-C",
            str(target_root),
            "-c",
            "user.name=Synthetic policy verification",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "--quiet",
            "-m",
            "Disposable product policy source",
        ],
        check=True,
    )
    return target_root


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--product", choices=PRODUCTS, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--output", type=Path)
    mode.add_argument("--tests", action="store_true")
    args = parser.parse_args()
    command = (
        [
            sys.executable,
            "-m",
            "unittest",
            "discover",
            "-s",
            "scripts/ci",
            "-p",
            "test_*.py",
        ]
        if args.tests
        else [
            sys.executable,
            "scripts/ci/security.py",
            "--output",
            str(args.output.resolve()),
        ]
    )
    with tempfile.TemporaryDirectory(prefix="onesa-product-policy-") as directory:
        product = export_product(Path(directory), args.product)
        return subprocess.run(
            command,
            cwd=product,
            check=False,
        ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
