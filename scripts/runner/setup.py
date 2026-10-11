#!/usr/bin/env python3
"""Install/reconcile the single repository runner; GitHub credentials stay on the host."""
import json
from pathlib import Path
import subprocess
import sys

REPO = 'DruHustle/onesa-company-portal'
VM = 'onesa-portal-ci'
NAME = 'onesa-portal-local-arm64'
HERE = Path(__file__).resolve().parent


def run(*args, capture=False, data=None):
    return subprocess.run(args, input=data, text=True, check=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def api(path, *args):
    return json.loads(run('gh', 'api', path, *args, capture=True))


def guest(*args, **kwargs):
    return run('limactl', 'shell', VM, '--', *args, **kwargs)


def main():
    repo = api(f'repos/{REPO}')
    if not repo['private'] or not repo['permissions'].get('admin'):
        sys.exit('Refusing setup: a private repository and admin access are required.')
    runners = api(f'repos/{REPO}/actions/runners')['runners']
    matches = [r for r in runners if r['name'] == NAME]
    if len(matches) > 1:
        sys.exit('Duplicate runner names require manual investigation; refusing replacement.')
    if matches and matches[0]['busy']:
        sys.exit('Runner is busy; retry maintenance after the current job finishes.')
    instances = [json.loads(line) for line in run('limactl', 'list', '--json', capture=True).splitlines() if line.strip()]
    existing = next((v for v in instances if v['name'] == VM), None)
    if existing is None:
        if matches:
            sys.exit('Matching GitHub runner exists without this VM; refusing replacement.')
        run('limactl', 'start', '--tty=false', '--name', VM, str(HERE / 'lima.yaml'))
    else:
        config = existing['config']
        if config.get('mounts') or config['ssh'].get('forwardAgent'):
            sys.exit('Existing VM exposes host mounts/agent; refusing to install.')
        if config['arch'] != 'aarch64' or not any(p.get('ignore') and p.get('proto') == 'any' and p.get('guestIP') == '0.0.0.0' for p in config['portForwards']):
            sys.exit('Existing VM architecture/forwarding differs from the isolated template.')
        if existing['status'] != 'Running':
            run('limactl', 'start', '--tty=false', VM)
    if matches:
        guest('sudo', 'test', '-f', '/opt/onesa-actions-runner/.runner')
    release = api('repos/actions/runner/releases/latest')
    asset = next(a for a in release['assets'] if a['name'].startswith('actions-runner-linux-arm64-'))
    digest = asset.get('digest', '')
    if not digest.startswith('sha256:') or len(digest) != 71:
        sys.exit('Official release asset has no SHA-256 digest; refusing download.')
    for filename in ['install-guest.sh', 'provision-guest.sh', 'job-completed.sh']:
        run('limactl', 'copy', str(HERE / filename), f'{VM}:/tmp/onesa-{filename}')
    token = '' if matches else api(f'repos/{REPO}/actions/runners/registration-token', '-X', 'POST')['token']
    guest('sudo', '-u', 'portalci', '-H', 'bash', '/tmp/onesa-install-guest.sh', release['tag_name'],
          asset['browser_download_url'], digest.removeprefix('sha256:'), data=token + '\n')
    token = None
    guest('sudo', 'install', '-m', '755', '-o', 'root', '-g', 'root',
          '/tmp/onesa-job-completed.sh', '/opt/onesa-actions-runner/job-completed.sh')
    lock = json.loads((HERE.parent.parent / 'onesa-company-portal-frontend/package-lock.json').read_text())
    playwright = lock['packages']['node_modules/playwright']['version']
    installed = guest('sudo', 'bash', '-c', 'test ! -f /opt/onesa-actions-runner/.service || cat /opt/onesa-actions-runner/.service', capture=True).strip()
    if installed:
        guest('sudo', 'systemctl', 'restart', installed)
    else:
        guest('sudo', 'bash', '/tmp/onesa-provision-guest.sh', playwright)
    print(f'Runner reconciled: {REPO} / {NAME}; initial release {release["tag_name"]}, SHA-256 {digest[7:]}')
    print('Use scripts/runner/status.sh to verify GitHub connectivity.')


if __name__ == '__main__':
    main()
