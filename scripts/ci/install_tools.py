"""Install only checksum-pinned official standalone review tools; no source upload."""

import argparse
import hashlib
import io
import json
import os
import platform
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def install(target, names=None):
    system = platform.system().lower()
    machine = {"x86_64": "amd64", "aarch64": "arm64"}.get(
        platform.machine(), platform.machine()
    )
    key = system + "-" + machine
    lock = json.loads((ROOT / "scripts/ci/tools.lock.json").read_text())
    target.mkdir(parents=True, exist_ok=True)
    for name in names or lock:
        item = lock[name]["assets"].get(key)
        if item is None:
            raise ValueError("Unsupported review-tool platform: " + key)
        destination = target / name
        if (
            destination.is_file()
            and hashlib.sha256(destination.read_bytes()).hexdigest()
            == item["binary_sha256"]
        ):
            continue
        if not item["url"].startswith("https://github.com/"):
            raise ValueError(
                "Review tools must come from a pinned official GitHub release"
            )
        with urllib.request.urlopen(item["url"], timeout=90) as response:
            data = response.read(100 * 1024 * 1024 + 1)
        if (
            len(data) > 100 * 1024 * 1024
            or hashlib.sha256(data).hexdigest() != item["sha256"]
        ):
            raise ValueError("Review tool checksum/size verification failed: " + name)
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            members = [
                m
                for m in archive.getmembers()
                if m.isfile() and Path(m.name).name == name
            ]
            if len(members) != 1 or members[0].size > 100 * 1024 * 1024:
                raise ValueError("Unexpected review tool archive")
            binary = archive.extractfile(members[0]).read()
        if hashlib.sha256(binary).hexdigest() != item["binary_sha256"]:
            raise ValueError("Review tool binary integrity failed")
        temporary = target / (name + ".tmp")
        temporary.write_bytes(binary)
        temporary.chmod(0o755)
        temporary.replace(destination)
    return target


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--directory",
        type=Path,
        default=Path(os.getenv("RUNNER_TEMP", "/private/tmp")) / "onesa-review-tools",
    )
    parser.add_argument("--only", nargs="+")
    args = parser.parse_args()
    target = install(args.directory, args.only)
    if os.getenv("GITHUB_PATH"):
        with open(os.environ["GITHUB_PATH"], "a") as output:
            output.write(str(target.resolve()) + "\n")
    print(
        "Checksum-verified review tools:",
        ", ".join(args.only or ["reviewdog", "zizmor", "gitleaks", "actionlint"]),
    )


if __name__ == "__main__":
    main()
