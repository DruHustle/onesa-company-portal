#!/bin/bash
# Run as portalci; token arrives through stdin, never as a command argument.
set -euo pipefail
umask 077
cd /opt/onesa-actions-runner
[[ "$1" == v* ]] || exit 1
archive_url="$2"
checksum="$3"
if [[ ! -f .runner ]]; then
  curl --fail --location --retry 3 "$archive_url" -o /tmp/onesa-runner.tar.gz
  printf '%s  %s\n' "$checksum" /tmp/onesa-runner.tar.gz | sha256sum --check --strict
  tar xzf /tmp/onesa-runner.tar.gz
  rm /tmp/onesa-runner.tar.gz
  IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN
  export ACTIONS_RUNNER_INPUT_TOKEN
  ./config.sh --unattended --url https://github.com/DruHustle/onesa-company-portal \
    --name onesa-portal-local-arm64 --labels onesa-portal-local --work _work
  unset ACTIONS_RUNNER_INPUT_TOKEN
else
  python3 - <<'PY'
import json
from pathlib import Path
config = json.loads(Path('.runner').read_text(encoding='utf-8-sig'))
assert config['agentName'] == 'onesa-portal-local-arm64'
assert config['gitHubUrl'].rstrip('/') == 'https://github.com/DruHustle/onesa-company-portal'
PY
fi
# Keep automatic runner updates enabled; the initial version is recorded by the host.
printf '%s\n' 'RUNNER_TOOL_CACHE=/opt/hostedtoolcache' 'AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache' \
 'ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/opt/onesa-actions-runner/job-completed.sh' >> .env
sort -u .env -o .env
