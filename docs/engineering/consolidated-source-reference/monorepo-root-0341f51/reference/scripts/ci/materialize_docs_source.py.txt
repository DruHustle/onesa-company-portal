"""Read only pinned public contract files from preserved local Git ancestry."""

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import PurePosixPath

from config import ROOT

SOURCES = {"portal": "onesa-company-portal", "robot": "onesa-ai-robot"}
MAX_FILE_BYTES = 8 * 1024 * 1024


def safe_relative(value):
    if not isinstance(value, str):
        raise TypeError("Invalid pinned source path")
    path = PurePosixPath(value)
    if (
        path.is_absolute()
        or str(path) != value
        or not path.parts
        or any(part in {".", "..", ".git"} for part in path.parts)
        or any(ord(character) < 32 for character in value)
    ):
        raise ValueError("Invalid pinned source path")
    return path


def git(root, *args):
    return subprocess.check_output(
        ["git", "-C", str(root), *args], stderr=subprocess.PIPE
    )


def materialize(root, source):
    platform = root / "onesa-ai-platform"
    manifest = json.loads(
        (platform / "docs/ecosystem/source-revisions.json").read_text()
    )
    record = manifest[SOURCES[source]]
    sha = record.get("commit", "")
    if not isinstance(sha, str) or not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("A full pinned source revision is required")
    if record.get("repository") != "https://github.com/DruHustle/" + SOURCES[source]:
        raise ValueError("Unexpected historical source identity")
    # No clone, credentials, network, mutable branch or current sibling source.
    git(root, "merge-base", "--is-ancestor", sha, "HEAD")
    destination = platform / "data/docs-sources" / source
    if any(path.is_symlink() for path in [destination, *destination.parents]):
        raise ValueError("Pinned source destination must not contain aliases")
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("Refusing to replace an existing pinned source directory")
    sources = record.get("sources")
    if not isinstance(sources, dict) or not 1 <= len(sources) <= 100:
        raise ValueError("Invalid pinned source inventory")
    checked = []
    for name, expected in sources.items():
        path = safe_relative(name)
        if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
            raise ValueError("Invalid pinned source digest")
        object_name = sha + ":" + name
        if git(root, "cat-file", "-t", object_name).strip() != b"blob":
            raise ValueError("Pinned source must be a file")
        if int(git(root, "cat-file", "-s", object_name)) > MAX_FILE_BYTES:
            raise ValueError("Pinned source exceeds file limit")
        data = git(root, "cat-file", "blob", object_name)
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(
                "Pinned public source digest differs from reviewed manifest"
            )
        checked.append((path, data))
    if sum(len(data) for _, data in checked) > 32 * 1024 * 1024:
        raise ValueError("Pinned source inventory exceeds size limit")
    for path, data in checked:
        target = destination / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    print(
        f"Verified {len(checked)} pinned {source} contract files from preserved history"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, choices=SOURCES)
    args = parser.parse_args()
    materialize(ROOT, args.source)


if __name__ == "__main__":
    main()
