#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# System packages are provisioned by the Lima template. Runner jobs need no sudo.
cd /opt/onesa-actions-runner
./bin/installdependencies.sh
# Provision all OS browser libraries once. Use official Node distribution/checksum.
version=24.21.0
archive=node-v${version}-linux-arm64.tar.xz
install -d /opt/onesa-node
curl -fsSL --retry 3 "https://nodejs.org/dist/v${version}/${archive}" -o "/tmp/${archive}"
curl -fsSL --retry 3 "https://nodejs.org/dist/v${version}/SHASUMS256.txt" -o /tmp/onesa-node-checksums
(cd /tmp; awk -v file="$archive" '$2 == file' onesa-node-checksums | sha256sum --check --strict)
tar xJf "/tmp/${archive}" -C /opt/onesa-node --strip-components=1
rm "/tmp/${archive}" /tmp/onesa-node-checksums
export PATH="/opt/onesa-node/bin:$PATH"
# Version supplied from the committed frontend lockfile by setup.py.
npx --yes "playwright@$1" install-deps chromium firefox webkit
# Registration and service activation require shared-setup.py privacy checks.
