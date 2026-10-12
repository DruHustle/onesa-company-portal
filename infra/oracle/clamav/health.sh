#!/bin/sh
set -eu
umask 027
marker=/run/onesa-scanner/scanner-ready
# Health proves current signatures and a responsive loaded daemon; no public probe.
if test -n "$(find /var/lib/clamav -maxdepth 1 -type f \( -name daily.cvd -o -name daily.cld \) -mmin -2880 -print -quit)" &&
   clamdscan --config-file=/etc/clamav/clamd.conf --ping=1 >/dev/null 2>&1; then
  date +%s > "$marker.tmp"
  mv -f -- "$marker.tmp" "$marker"
else
  rm -f -- "$marker"
  exit 1
fi
