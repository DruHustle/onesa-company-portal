"""Verify Portal production CMD with isolated test credentials and role checks."""
import argparse
import json
import os
import subprocess
import time
import uuid
from contextlib import contextmanager
from urllib.parse import urlsplit, urlunsplit


def docker(*args, check=True):
    return subprocess.run(['docker', *args], check=check, capture_output=True, text=True).stdout.strip()


@contextmanager
def database_fixture(image, network):
    """Prepare a disposable database when the image job has no shared test service."""
    configured = os.environ.get('TEST_DATABASE_URL')
    if configured:
        yield configured
        return
    name = 'onesa-portal-db-smoke-' + uuid.uuid4().hex[:12]
    try:
        docker('run', '-d', '--name', name, '-p', '127.0.0.1::5432',
               '-e', 'POSTGRES_USER=portal_test', '-e', 'POSTGRES_DB=onesa_portal_test',
               '-e', 'POSTGRES_PASSWORD=ci-only-test-password', 'postgres:17-alpine')
        for _ in range(60):
            result = subprocess.run(['docker', 'exec', name, 'pg_isready',
                                     '-h', '127.0.0.1', '-U', 'portal_test', '-d', 'onesa_portal_test'], capture_output=True)
            if result.returncode == 0:
                break
            time.sleep(.5)
        else:
            raise AssertionError('Disposable PostgreSQL fixture unavailable')
        port = docker('port', name, '5432/tcp').rsplit(':', 1)[1]
        owner = 'postgresql://portal_test:ci-only-test-password@127.0.0.1:' + port + '/onesa_portal_test'
        docker('run', '--rm', '--network', network, '-e', 'DATABASE_URL=' + owner,
               '-e', 'NODE_ENV=test', '-e', 'SESSION_KEY=' + 'x' * 64,
               '--entrypoint', 'node', image, '--input-type=module', '-e',
               "import {migrate} from './dist/src/services/migrate.js';"
               "import {db} from './dist/src/services/db.js';"
               "import {provisionApplicationRole} from './dist/src/services/database-role.js';"
               "try {await migrate();await provisionApplicationRole(db,"
               "'database-role-test-only-password-1234567890','onesa_portal_app_test');}"
               "finally {await db.end();}")
        yield owner
    finally:
        docker('rm', '-f', name, check=False)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('image')
    parser.add_argument('--network', default='host')
    args=parser.parse_args()
    with database_fixture(args.image, args.network) as owner:
        verify_runtime(args.image, args.network, owner)


def verify_runtime(image, network, owner):
    parsed=urlsplit(owner)
    assert parsed.path.endswith('_test'), 'Disposable test database required'
    app=urlunsplit(parsed._replace(netloc='onesa_portal_app_test:database-role-test-only-password-1234567890@'+parsed.netloc.split('@')[-1]))
    unavailable='postgresql://fixture:fixture@127.0.0.1:1/onesa_portal_test'
    config=json.loads(docker('image','inspect',image))[0]['Config']
    assert config['Cmd']==['node','dist/src/server.js']
    for url, expected in [(owner,503),(app,200),(unavailable,503)]:
        name='onesa-portal-smoke-'+uuid.uuid4().hex[:12]
        try:
            docker('run','-d','--name',name,'--network',network,
                   '-e','DATABASE_URL='+url,'-e','PORT=10000','-e','NODE_ENV=production',
                   '-e','SESSION_KEY='+'x'*64,'-e','PROXY_SHARED_KEY='+'x'*64,
                   '-e','PUBLIC_ORIGIN=https://portal.example.invalid',image)
            for _ in range(60):
                result=subprocess.run(['docker','exec',name,'node','-e',
                    "fetch('http://127.0.0.1:10000/api/v1/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"],capture_output=True)
                if result.returncode==0:break
                time.sleep(.5)
            else:raise AssertionError('Production CMD health unavailable')
            docker('exec',name,'node','-e',
                f"const assert=require('node:assert/strict');(async()=>{{assert.equal((await fetch('http://127.0.0.1:10000/api/v1/ready')).status,{expected});assert.equal((await fetch('http://127.0.0.1:10000/api/v1/auth/me')).status,401);}})().catch(()=>process.exit(1))")
            assert docker('inspect','-f','{{.State.Running}}',name)=='true'
            docker('stop','-t','10',name)
            assert docker('inspect','-f','{{.State.ExitCode}}',name)=='0'
        finally:docker('rm','-f',name,check=False)
    print('PASS: production CMD/PORT/health/owner 503/restricted role 200/unavailable DB 503/authentication/SIGTERM')


if __name__=='__main__':main()
