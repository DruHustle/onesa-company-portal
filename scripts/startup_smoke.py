"""Verify Portal production CMD with isolated test credentials and role checks."""
import argparse
import json
import os
import subprocess
import time
import uuid
from urllib.parse import urlsplit, urlunsplit


def docker(*args, check=True):
    return subprocess.run(['docker', *args], check=check, capture_output=True, text=True).stdout.strip()


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('image')
    parser.add_argument('--network', default='host')
    args=parser.parse_args()
    owner=os.environ['TEST_DATABASE_URL']
    parsed=urlsplit(owner)
    assert parsed.path.endswith('_test'), 'Disposable test database required'
    app=urlunsplit(parsed._replace(netloc='onesa_portal_app_test:database-role-test-only-password-1234567890@'+parsed.netloc.split('@')[-1]))
    unavailable='postgresql://fixture:fixture@127.0.0.1:1/onesa_portal_test'
    config=json.loads(docker('image','inspect',args.image))[0]['Config']
    assert config['Cmd']==['node','dist/src/server.js']
    for url, expected in [(owner,503),(app,200),(unavailable,503)]:
        name='onesa-portal-smoke-'+uuid.uuid4().hex[:12]
        try:
            docker('run','-d','--name',name,'--network',args.network,
                   '-e','DATABASE_URL='+url,'-e','PORT=10000','-e','NODE_ENV=production',
                   '-e','SESSION_KEY='+'x'*64,'-e','PROXY_SHARED_KEY='+'x'*64,
                   '-e','PUBLIC_ORIGIN=https://portal.example.invalid',args.image)
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
