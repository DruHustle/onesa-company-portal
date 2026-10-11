#!/bin/bash
set -euo pipefail
root=$(dirname "$(realpath "$0")")
python3 "$root/visibility.py" "$root/config.json"
python3 /usr/local/lib/onesa-ci/lease.py acquire
# Visibility may change while waiting for another private repository job.
python3 "$root/visibility.py" "$root/config.json"
