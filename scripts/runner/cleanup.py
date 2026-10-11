#!/usr/bin/env python3
"""Narrow sudo helper: remove only the calling runner's fixed checkout."""

import os
import shutil
from pathlib import Path

ROOTS = {
    "portalci": ("/opt/onesa-actions-runner", "onesa-company-portal"),
    "platformci": ("/opt/onesa-platform-runner", "onesa-ai-platform"),
    "robotci": ("/opt/onesa-robot-runner", "onesa-ai-robot"),
}
root, repository = ROOTS[os.environ["SUDO_USER"]]
work = Path(root) / "_work"
assert not work.is_symlink()
checkout = work / repository
if checkout.is_symlink():
    checkout.unlink()
elif checkout.exists():
    shutil.rmtree(checkout)
