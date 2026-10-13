#!/bin/sh
# Run only on the reviewed dedicated staging VM; preserve Oracle metadata rules.
set -eu
test "$(id -u)" = 0 || { echo 'Run with sudo.' >&2; exit 1; }
test "$(uname -m)" = aarch64 || { echo 'ARM64 required.' >&2; exit 1; }
# shellcheck source=/dev/null
. /etc/os-release
test "$ID:$VERSION_ID" = ubuntu:24.04 || { echo 'Ubuntu 24.04 required.' >&2; exit 1; }
test "$#" -gt 0 || { echo 'Approved administrative public IPv4 /32 required.' >&2; exit 1; }
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# Re-running hardening retains the already approved sources.
if test -e /etc/onesa/worker-admin-cidr || test -L /etc/onesa/worker-admin-cidr; then
  admin_cidrs=$(python3 "$script_dir/admin-sources.py" --file /etc/onesa/worker-admin-cidr --require-ssh-session "$@")
else
  admin_cidrs=$(python3 "$script_dir/admin-sources.py" --require-ssh-session "$@")
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get -y --with-new-pkgs upgrade
apt-get install -y --no-install-recommends docker.io docker-compose-v2 unattended-upgrades
install -d -m 700 /etc/onesa
install -d -o root -g root -m 755 /usr/local/lib/onesa
install -o root -g root -m 700 "$script_dir/admin-sources.py" /usr/local/lib/onesa/admin-sources.py
install -o root -g root -m 700 "$script_dir/worker-firewall.sh" /usr/local/sbin/onesa-worker-firewall
sources_tmp=$(mktemp /etc/onesa/.worker-admin-cidr.XXXXXX)
trap 'rm -f -- "$sources_tmp"' 0
printf '%s\n' "$admin_cidrs" > "$sources_tmp"
chown root:root "$sources_tmp"
chmod 600 "$sources_tmp"
mv -f -- "$sources_tmp" /etc/onesa/worker-admin-cidr
trap - 0
cat > /etc/ssh/sshd_config.d/00-onesa-worker.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
EOF
sshd -t
systemctl reload ssh.service
cat > /etc/apt/apt.conf.d/52onesa-worker <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Automatic-Reboot "false";
EOF
cat > /etc/systemd/system/onesa-worker-firewall.service <<'EOF'
[Unit]
Description=Onesa staging worker ingress firewall
After=network-online.target docker.service
Wants=network-online.target docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/onesa-worker-firewall
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
EOF
install -d -m 755 /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/onesa-worker-firewall.conf <<'EOF'
[Service]
ExecStartPost=/usr/local/sbin/onesa-worker-firewall
EOF
# This dedicated executor uses no NFS/RPC services.
systemctl disable --now rpcbind.socket rpcbind.service
systemctl mask rpcbind.socket rpcbind.service
systemctl daemon-reload
systemctl enable --now docker.service apt-daily-upgrade.timer onesa-worker-firewall.service
iptables -C INPUT -j ONESA_WORKER_INPUT
ip6tables -C INPUT -j ONESA_WORKER_INPUT
sshd -T | sed -n '/^passwordauthentication /p;/^kbdinteractiveauthentication /p;/^permitrootlogin /p'
echo 'Worker host hardening applied; verify a new SSH connection before closing this session.'
test ! -e /var/run/reboot-required || echo 'Security updates require a controlled staging reboot.'
