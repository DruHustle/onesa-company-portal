#!/bin/bash
set -euo pipefail
# One repository and one serial runner own this workspace. No host mounts exist.
workspace=/opt/onesa-actions-runner/_work/onesa-company-portal
[[ $(id -un) == portalci && ! -L "$workspace" ]] || exit 1
rm -rf -- "$workspace"
# Retain logs for diagnosis, bounded to two weeks.
find /opt/onesa-actions-runner/_diag -type f -name '*.log' -mtime +14 -delete
