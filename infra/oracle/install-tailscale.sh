#!/bin/sh
set -eu
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
test -f "$script_dir/tailscaled-firewall.conf"
test "$(id -u)" = 0
test "$(uname -m)" = aarch64
test "$(cat /etc/hostname)" = onesa-portal-worker
# shellcheck source=/dev/null
. /etc/os-release
test "$ID:$VERSION_ID" = ubuntu:24.04
# An existing device identity needs reconciliation instead of blind enrollment.
test ! -s /var/lib/tailscale/tailscaled.state
umask 022
work=$(mktemp -d /tmp/onesa-tailscale-install.XXXXXX)
trap 'rm -rf -- "$work"' EXIT
curl --proto '=https' --tlsv1.2 -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o "$work/keyring.gpg"
curl --proto '=https' --tlsv1.2 -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o "$work/tailscale.list"
python3 - "$work/tailscale.list" <<'PY'
import sys
from pathlib import Path
actual=[line.strip() for line in Path(sys.argv[1]).read_text().splitlines() if line.strip() and not line.startswith('#')]
assert actual==['deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu noble main'], 'Unexpected package repository'
PY
for pair in keyring.gpg:/usr/share/keyrings/tailscale-archive-keyring.gpg tailscale.list:/etc/apt/sources.list.d/tailscale.list; do
  source=${pair%%:*}
  destination=${pair#*:}
  if test -e "$destination" || test -L "$destination"; then
    test -f "$destination" && test ! -L "$destination"
    cmp -s "$work/$source" "$destination"
  else
    install -o root -g root -m 644 "$work/$source" "$destination"
  fi
done
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
apt-get update -qq
apt-get install -y --no-install-recommends tailscale
install -d -o root -g root -m 755 /etc/systemd/system/tailscaled.service.d
install -o root -g root -m 644 "$script_dir/tailscaled-firewall.conf" /etc/systemd/system/tailscaled.service.d/10-onesa-firewall.conf
systemctl daemon-reload
systemctl enable --now tailscaled.service
tailscale version
systemctl is-active tailscaled.service
systemctl is-active docker.service onesa-worker-firewall.service onesa-portal-production-worker.service
