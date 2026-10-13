#!/bin/sh
set -eu
admin_cidrs=$(python3 /usr/local/lib/onesa/admin-sources.py --file /etc/onesa/worker-admin-cidr)
# Validate every source before touching the dedicated chains. Preserve Oracle rules.
iptables -N ONESA_WORKER_INPUT 2>/dev/null || true
iptables -F ONESA_WORKER_INPUT
iptables -A ONESA_WORKER_INPUT -i lo -j ACCEPT
iptables -A ONESA_WORKER_INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# Intentional splitting: the validator emits only canonical public IPv4 /32 values.
for admin_cidr in $admin_cidrs; do
  iptables -A ONESA_WORKER_INPUT -s "$admin_cidr" -p tcp --dport 22 -j ACCEPT
done
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
external_iface=$(ip -4 route show default | awk 'NR==1 {print $5}')
test -n "$external_iface"
iptables -C DOCKER-USER -i "$external_iface" -m conntrack --ctstate NEW -j DROP 2>/dev/null ||
  iptables -I DOCKER-USER 1 -i "$external_iface" -m conntrack --ctstate NEW -j DROP
