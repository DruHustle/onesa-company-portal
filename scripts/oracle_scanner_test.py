"""Real private ARM64 scanner acceptance with synthetic bytes; no candidate records."""

import json
import subprocess
from datetime import datetime, timezone

import oracle_worker as worker


PROGRAM = r"""
import {randomBytes} from 'node:crypto';
for (const key of Object.keys(process.env)) {
  if (/^(AWS_|S3_|SMTP_|RESEND_|MAIL_|COMPANY_ORIGIN$|NOTIFY_EMAIL$)/.test(key)) delete process.env[key];
}
process.env.NODE_ENV='test';
process.env.DATABASE_URL='postgresql://audit@127.0.0.1/audit';
process.env.SESSION_KEY=randomBytes(32).toString('hex');
process.env.PUBLIC_ORIGIN='https://synthetic.example.invalid';
process.env.CLAMAV_SOCKET='/run/onesa-scanner/clamd.sock';
delete process.env.CLAMAV_HOST;
const {scan}=await import('./dist/src/services/storage.js');
const {env}=await import('./dist/src/config/env.js');
const start=performance.now();
const benign=await scan(Buffer.from('%PDF-1.7\nOnesa synthetic scanner acceptance\n%%EOF'));
// Standard harmless EICAR signature, never downloaded malware.
const eicar=Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
const infected=await scan(eicar);
env.CLAMAV_SOCKET='/run/onesa-scanner/absent-test.sock';
let failureDenied=false;
try {failureDenied=(await scan(Buffer.from('synthetic unavailable scanner')))!=='clean';}
catch {failureDenied=true;}
env.CLAMAV_SOCKET=undefined;
const unconfigured=await scan(Buffer.from('synthetic unconfigured scanner'));
const passed=benign==='clean'&&infected==='rejected'&&failureDenied&&unconfigured==='quarantine';
console.log(JSON.stringify({benign,infected,failureDenied,unconfigured,elapsed_ms:Math.round(performance.now()-start),passed}));
process.exitCode=passed?0:1;
"""


def main():
    receipt = json.loads((worker.PRIVATE / "deployment.json").read_text())
    sha = receipt["commit"]
    worker.qualified_source(sha, worker.evidence.GitHub())
    worker.require(receipt["instance_ocid"] == worker.INSTANCE and receipt["scope"] == "staging",
                   "Exact staging scanner deployment required")
    release = "/opt/onesa/portal-staging/releases/" + sha
    prefix = "sudo env PORTAL_WORKER_IMAGE=onesa-portal-worker:" + sha + " PORTAL_SCANNER_IMAGE=onesa-portal-clamav:" + sha + " docker compose -f " + release + "/compose.oracle-staging.yaml"
    command = prefix + " --profile jobs run --rm --no-deps -T worker node --input-type=module"
    result = subprocess.run(worker.ssh() + [command], input=PROGRAM.encode(), capture_output=True, timeout=180)
    worker.require(result.returncode == 0, "Real scanner acceptance failed; no hosted PASS recorded")
    lines = result.stdout.decode().splitlines()
    data = json.loads(lines[-1])
    worker.require(data.get("passed") is True, "Real scanner acceptance incomplete")
    report = {"checked_at": datetime.now(timezone.utc).isoformat(), "instance_ocid": worker.INSTANCE,
              "commit": sha, "scope": "synthetic bytes through actual Portal Unix-socket scanner client",
              "checks": data, "database_jobs_verified": False, "private_upload_workflow_verified": False,
              "production_qualified": False}
    path = worker.PRIVATE / "scanner-acceptance.json"
    path.write_text(json.dumps(report, indent=2) + "\n")
    path.chmod(0o600)
    print(json.dumps(data))


if __name__ == "__main__":
    main()
