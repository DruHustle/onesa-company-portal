"""Names from source, or read-only staging identities/counts; never document contents."""

import argparse
import json
import re
import subprocess

import oracle_worker as worker


def names():
    source = (worker.ROOT / "onesa-company-portal-backend/src/config/env.ts").read_text()
    declared = set(re.findall(r"\b([A-Z][A-Z0-9_]+)\s*:", source))
    declared.update(re.findall(r"process\.env\.([A-Z][A-Z0-9_]*)", source))
    # The locked SDK's environment credential adapter supplies these supported names.
    declared.update({"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"})
    return sorted(declared)


PROGRAM = r"""
let pool,client;
try {
 const expectedHost=EXPECTED_HOST,expectedBucket=EXPECTED_BUCKET;
 const url=new URL(process.env.DATABASE_URL||'');
 if(url.hostname!==expectedHost||process.env.S3_BUCKET!==expectedBucket||!['postgres:','postgresql:'].includes(url.protocol)) throw Error('Target mismatch');
 const {db}=await import('./dist/src/services/db.js');pool=db;
 const {applicationRoleSafe}=await import('./dist/src/services/database-role.js');
 const {env}=await import('./dist/src/config/env.js');
 client=await db.connect();
 await client.query('BEGIN READ ONLY');
 await client.query("SET LOCAL statement_timeout='5s'");
 const safe=await applicationRoleSafe(client);
 const identity=(await client.query('SELECT current_database() AS database')).rows[0];
 const counts=(await client.query("SELECT (SELECT count(*) FROM files)::int AS files, (SELECT count(*) FROM files WHERE classification='applicant')::int AS applicant_files, (SELECT count(*) FROM applications)::int AS applications, (SELECT count(*) FROM jobs WHERE status IN ('pending','running'))::int AS pending_jobs")).rows[0];
 await client.query('ROLLBACK');
 const {S3Client,ListObjectsV2Command}=await import('@aws-sdk/client-s3');
 const s3=new S3Client({region:env.S3_REGION,endpoint:env.S3_ENDPOINT,forcePathStyle:!!env.S3_ENDPOINT});
 const result=await s3.send(new ListObjectsV2Command({Bucket:expectedBucket,MaxKeys:1}),{abortSignal:AbortSignal.timeout(10000)});
 console.log(JSON.stringify({endpoint_match:true,bucket_match:true,database:identity.database==='neondb'?'neondb':'other',restricted_role:safe,counts,bucket_list_access:result.$metadata.httpStatusCode===200,bucket_has_objects:!!result.Contents?.length,synthetic_data_verified:false,bucket_privacy_verified:false,document_contents_accessed:false}));
} catch {console.log(JSON.stringify({verified:false,reason:'configuration_target_permissions_or_connectivity',synthetic_data_verified:false,document_contents_accessed:false}));process.exitCode=1;}
finally {client?.release();await pool?.end();}
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--remote", action="store_true")
    parser.add_argument("--expected-database-endpoint")
    parser.add_argument("--expected-bucket")
    args = parser.parse_args()
    if not args.remote:
        print(json.dumps({"supported_names": names(), "values_read": False}, indent=2))
        return
    worker.require(bool(re.fullmatch(r"ep-[a-z0-9-]+(?:\.[a-z0-9-]+)+\.neon\.tech", args.expected_database_endpoint or "")), "Actual approved Portal staging Neon hostname required, never a connection string")
    worker.require(bool(re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", args.expected_bucket or "")), "Actual staging bucket identifier required")
    receipt=json.loads((worker.PRIVATE / "deployment.json").read_text())
    sha=receipt["commit"]
    worker.qualified_source(sha,worker.evidence.GitHub())
    release="/opt/onesa/portal-staging/releases/"+sha
    prefix="sudo env PORTAL_WORKER_IMAGE=onesa-portal-worker:"+sha+" PORTAL_SCANNER_IMAGE=onesa-portal-clamav:"+sha+" docker compose -f "+release+"/compose.oracle-staging.yaml"
    command="set -eu\nsudo test ! -L /etc/onesa/portal-staging.env\nsudo test -f /etc/onesa/portal-staging.env\ntest \"$(sudo stat -c '%a:%U' /etc/onesa/portal-staging.env)\" = '600:root'\n"+prefix+" --profile jobs run --rm --no-deps -T worker node --input-type=module"
    program=PROGRAM.replace("EXPECTED_HOST",json.dumps(args.expected_database_endpoint)).replace("EXPECTED_BUCKET",json.dumps(args.expected_bucket))
    result=subprocess.run(worker.ssh()+[command],input=program.encode(),capture_output=True,timeout=60)
    worker.require(result.returncode==0,"Read-only identity verification failed; no credential values disclosed")
    record=json.loads(result.stdout.decode().splitlines()[-1])
    path=worker.PRIVATE / "staging-data-inventory.json"
    path.write_text(json.dumps(record,indent=2)+"\n");path.chmod(0o600)
    print(json.dumps(record))


if __name__ == "__main__":
    main()
