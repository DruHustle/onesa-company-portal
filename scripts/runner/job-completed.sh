#!/bin/bash
set -euo pipefail
# Release only our own lease, even when checkout cleanup fails.
trap 'python3 /usr/local/lib/onesa-ci/lease.py release' EXIT
sudo /usr/local/lib/onesa-ci/cleanup.py
policy_root=$(dirname "$(realpath "$0")")
root=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["directory"])' "$policy_root/config.json")
find "$root/_diag" -type f -name '*.log' -mtime +14 -delete
