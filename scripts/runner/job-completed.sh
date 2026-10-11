#!/bin/bash
set -euo pipefail
# Release only our own lease, even when checkout cleanup fails.
trap 'python3 /usr/local/lib/onesa-ci/lease.py release' EXIT
sudo /usr/local/lib/onesa-ci/cleanup.py
root=$(dirname "$(realpath "$0")")
find "$root/_diag" -type f -name '*.log' -mtime +14 -delete
