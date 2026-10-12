#!/bin/sh
# Run only on the reviewed dedicated staging VM; preserve Oracle metadata rules.
set -eu
test "$(id -u)" = 0 || { echo 'Run with sudo.' >&2; exit 1; }
test "$(uname -m)" = aarch64 || { echo 'ARM64 required.' >&2; exit 1; }
. /etc/os-release
test "$ID:$VERSION_ID" = ubuntu:24.04 || { echo 'Ubuntu 24.04 required.' >&2; exit 1; }
admin_cidr=${1:?Approved administrative public IPv4 /32 required}
python3 - "$admin_cidr" "${SSH_CONNECTION:-}" <<'PY'
import ipaddress, sys
net = ipaddress.ip_network(sys.argv[1], strict=True)
source = sys.argv[2].split()
if net.version != 4 or net.prefixlen != 32 or not net.network_address.is_global:
    raise SystemExit('A single approved public IPv4 /32 is required')
if not source or ipaddress.ip_address(source[0]) not in net:
    raise SystemExit('Current SSH source must match the approved administrative source')
PY
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get -y --with-new-pkgs upgrade
apt-get install -y --no-install-recommends docker.io docker-compose-v2 unattended-upgrades
install -d -m 700 /etc/onesa
printf '%s\n' "$admin_cidr" > /etc/onesa/worker-admin-cidr
chmod 600 /etc/onesa/worker-admin-cidr
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
cat > /usr/local/sbin/onesa-worker-firewall <<'EOF'
#!/bin/sh
set -eu
admin_cidr=$(cat /etc/onesa/worker-admin-cidr)
# Add a dedicated chain without flushing Oracle's INPUT/OUTPUT/InstanceServices.
iptables -N ONESA_WORKER_INPUT 2>/dev/null || true
iptables -F ONESA_WORKER_INPUT
iptables -A ONESA_WORKER_INPUT -i lo -j ACCEPT
iptables -A ONESA_WORKER_INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A ONESA_WORKER_INPUT -s "$admin_cidr" -p tcp --dport 22 -j ACCEPT
iptables -A ONESA_WORKER_INPUT -p icmp -j ACCEPT
iptables -A ONESA_WORKER_INPUT -j DROP
iptables -C INPUT -j ONESA_WORKER_INPUT 2>/dev/null || iptables -I INPUT 1 -j ONESA_WORKER_INPUT
ip6tables -N ONESA_WORKER_INPUT 2>/dev/null || true
ip6tables -F ONESA_WORKER_INPUT
ip6tables -A ONESA_WORKER_INPUT -i lo -j ACCEPT
ip6tables -A ONESA_WORKER_INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A ONESA_WORKER_INPUT -p ipv6-icmp -j ACCEPT
ip6tables -A ONESA_WORKER_INPUT -j DROP
ip6tables -C INPUT -j ONESA_WORKER_INPUT 2>/dev/null || ip6tables -I INPUT 1 -j ONESA_WORKER_INPUT
# Docker published ports bypass host INPUT; deny new forwarding from the public NIC.
external_iface=$(ip -4 route show default | awk 'NR==1 {print $5}')
test -n "$external_iface"
iptables -C DOCKER-USER -i "$external_iface" -m conntrack --ctstate NEW -j DROP 2>/dev/null ||
  iptables -I DOCKER-USER 1 -i "$external_iface" -m conntrack --ctstate NEW -j DROP
EOF
chmod 700 /usr/local/sbin/onesa-worker-firewall
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
