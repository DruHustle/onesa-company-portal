"""Record monorepo image provenance after scanning; never grant release authority."""

import argparse
import json
import os
import re
import subprocess
from pathlib import Path

from config import PRODUCTS, REPOSITORY, ROOT


def source_identity(product, environment, git_command):
    if product not in PRODUCTS or environment.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise ValueError("Unexpected repository or product identity")
    if git_command("config", "--get", "remote.origin.url") not in {
        "https://github.com/" + REPOSITORY,
        "https://github.com/" + REPOSITORY + ".git",
        "git@github.com:" + REPOSITORY + ".git",
    }:
        raise ValueError("Unexpected source origin")
    sha = git_command("rev-parse", "HEAD")
    if not re.fullmatch(r"[a-f0-9]{40}", sha) or sha != environment.get("GITHUB_SHA"):
        raise ValueError("Checked source differs from the workflow revision")
    tree = git_command("rev-parse", sha + ":" + PRODUCTS[product])
    if not re.fullmatch(r"[a-f0-9]{40}", tree):
        raise ValueError("Invalid product source tree")
    if git_command("cat-file", "-t", tree) != "tree":
        raise ValueError("Product boundary must be a source tree")
    if git_command(
        "status", "--porcelain", "--untracked-files=normal", "--", PRODUCTS[product]
    ):
        raise ValueError("Product source differs from the verified revision")
    return {
        "schema_version": 2,
        "repository": REPOSITORY,
        "source_path": PRODUCTS[product],
        "candidate_commit": sha,
        "product_source_tree": tree,
        "verification_only": True,
        "release_authorized": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--product", choices=PRODUCTS, required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    def git_command(*parts):
        return subprocess.check_output(
            ["git", "-C", str(ROOT), *parts], text=True
        ).strip()

    record = source_identity(args.product, os.environ, git_command)
    image = subprocess.check_output(
        ["docker", "image", "inspect", args.image, "--format", "{{.Id}}"], text=True
    ).strip()
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
        raise ValueError("Invalid observed runtime image digest")
    record.update(image_digest=image, security="PASS")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
