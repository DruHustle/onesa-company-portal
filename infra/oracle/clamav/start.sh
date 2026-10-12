#!/bin/sh
set -eu
chgrp onesascan /run/onesa-scanner
chmod 2770 /run/onesa-scanner
# Fail startup when signature initialization fails; never label unscanned data clean.
freshclam --config-file=/etc/clamav/freshclam.conf
freshclam --daemon --foreground --config-file=/etc/clamav/freshclam.conf &
exec clamd --config-file=/etc/clamav/clamd.conf
