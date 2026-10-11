#!/bin/bash
set -euo pipefail
user=$1
root=$2
case "$user:$root" in
  portalci:/opt/onesa-actions-runner|platformci:/opt/onesa-platform-runner|robotci:/opt/onesa-robot-runner) ;;
  *) exit 1 ;;
esac
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker-compose-v2 python3-venv build-essential curl git jq unzip
getent group onesaci >/dev/null || groupadd onesaci
id "$user" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$user"
usermod -aG docker,onesaci "$user"
install -d -m 700 -o "$user" -g "$user" "$root" "$root/toolcache"
install -d -m 2770 -o root -g onesaci /var/lib/onesa-ci
install -d -m 755 -o root -g root /usr/local/lib/onesa-ci
install -m 755 -o root -g root /tmp/onesa-shared-lease.py /usr/local/lib/onesa-ci/lease.py
install -m 755 -o root -g root /tmp/onesa-shared-cleanup.py /usr/local/lib/onesa-ci/cleanup.py
for hook in job-started.sh job-completed.sh visibility.py config.json; do
  install -m 755 -o root -g root "/tmp/onesa-shared-$hook" "$root/$hook"
done
printf '%s ALL=(root) NOPASSWD: /usr/local/lib/onesa-ci/cleanup.py\n' "$user" > "/etc/sudoers.d/onesa-$user-cleanup"
chmod 440 "/etc/sudoers.d/onesa-$user-cleanup"
visudo -cf "/etc/sudoers.d/onesa-$user-cleanup"
# Browser OS dependencies; binary installs remain per repository/job, without sudo.
export PATH="/opt/onesa-node/bin:$PATH"
npx --yes playwright@1.64.0 install-deps chromium firefox webkit
cd /tmp
cp /tmp/onesa-shared-test_lease.py test_lease.py
cp /tmp/onesa-shared-lease.py lease.py
python3 -m unittest -v test_lease
