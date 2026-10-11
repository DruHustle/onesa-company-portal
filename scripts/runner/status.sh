#!/bin/bash
set -euo pipefail
limactl list onesa-portal-ci
# shellcheck disable=SC2016
limactl shell onesa-portal-ci -- sudo bash -c 'systemctl status "$(cat /opt/onesa-actions-runner/.service)" --no-pager; df -h /; docker system df'
gh api repos/DruHustle/onesa-company-portal/actions/runners --jq '.runners[] | select(.name=="onesa-portal-local-arm64") | {name,status,busy,labels:[.labels[].name]}'
