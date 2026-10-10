"""Synthetic backup rehearsal. Existing databases and production targets are refused."""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--container", required=True)
    parser.add_argument("--database", required=True)
    parser.add_argument("--storage", type=Path)
    parser.add_argument("--seed-storage-fixture", action="store_true")
    args = parser.parse_args()
    if args.container not in {"onesa-final-audit-ai-db-20261009", "onesa-final-audit-portal-db-20261009", "onesa-remediation-ai-db", "onesa-remediation-portal-db"} or args.database not in {"onesa_audit_test", "onesa_portal_audit_test"}:
        raise SystemExit("Refusing target outside the explicit synthetic audit allowlist")
    expected = "onesa_audit_test" if "-ai-db" in args.container else "onesa_portal_audit_test"
    if args.database != expected:
        raise SystemExit("Container/database pair does not match")
    os.umask(0o077)
    folder = ROOT / "data/remediation-20261010/backups" / str(time.time_ns())
    folder.mkdir(parents=True)
    restore = "onesa_audit_" + str(time.time_ns()) + "_restore"
    docker = ["docker", "exec", "-i", args.container]
    def query(database, sql):
        return subprocess.check_output(docker + ["psql", "-U", "audit_test", "-d", database, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], text=True).strip()
    fixture = None
    if args.seed_storage_fixture:
        if expected != "onesa_portal_audit_test" or not args.storage:
            raise SystemExit("Storage fixture applies only to the synthetic portal database")
        storage = args.storage.resolve()
        if not storage.is_relative_to(ROOT.resolve()):
            raise SystemExit("Refusing storage outside the isolated copy")
        storage.mkdir(parents=True, exist_ok=True)
        key = str(uuid.uuid4())
        content = b"synthetic backup reference fixture"
        file = storage / key
        file.write_bytes(content)
        digest_fixture = hashlib.sha256(content).hexdigest()
        query(args.database, "INSERT INTO files(id,filename,mime,size,storage_key,sha256,classification,scan_status,title) VALUES('" + key + "','backup-fixture.bin','application/octet-stream'," + str(len(content)) + ",'" + key + "','" + digest_fixture + "','internal','quarantine','Synthetic backup fixture')")
        fixture = {"key":key,"sha256":digest_fixture}
    started = time.monotonic()
    dump = folder / "database.dump"
    with dump.open("wb") as output:
        subprocess.run(docker + ["pg_dump", "-U", "audit_test", "-d", args.database, "-Fc", "--no-owner", "--no-acl"], stdout=output, check=True)
    digest = hashlib.sha256(dump.read_bytes()).hexdigest()
    (folder / "database.dump.sha256").write_text(digest + "  database.dump\n")
    subprocess.run(docker + ["createdb", "-U", "audit_test", restore], check=True)
    with dump.open("rb") as source:
        subprocess.run(docker + ["pg_restore", "-U", "audit_test", "-d", restore, "--no-owner", "--no-acl", "--exit-on-error"], stdin=source, check=True)
    tables = query(args.database, "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines()
    counts = {}
    table_hashes = {}
    for table in tables:
        quoted = '"' + table.replace('"', '""') + '"'
        before = query(args.database, "SELECT count(*) FROM " + quoted)
        after = query(restore, "SELECT count(*) FROM " + quoted)
        if before != after:
            raise SystemExit("Row-count mismatch; quiesce fixture writes and retry: " + table)
        counts[table] = int(after)
        sql = "SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) FROM " + quoted + " t"
        before_hash = query(args.database, sql)
        after_hash = query(restore, sql)
        assert before_hash == after_hash, "Restored row content differs: " + table
        table_hashes[table] = after_hash
    files = []
    if args.storage:
        storage = args.storage.resolve()
        if not storage.is_relative_to(ROOT.resolve()):
            raise SystemExit("Storage must be inside this isolated repository copy")
        for source in storage.rglob("*"):
            if source.is_symlink():
                raise SystemExit("Symlinked storage is not accepted")
            if source.is_file():
                target = folder / "storage" / source.relative_to(storage)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
                digest_file = hashlib.sha256(source.read_bytes()).hexdigest()
                assert hashlib.sha256(target.read_bytes()).hexdigest() == digest_file
                files.append({"key": str(source.relative_to(storage)), "sha256": digest_file})
    if fixture:
        assert query(restore, "SELECT sha256 FROM files WHERE storage_key='" + fixture["key"] + "'") == fixture["sha256"]
    record = {"status":"PASS", "scope":"synthetic database restore and local file copy/hash verification; excludes cloud encryption, PITR, full application recovery and provider snapshots", "database":args.database,"restore_database":restore,"dump_sha256":digest,"table_counts":counts,"table_hashes":table_hashes,"representative_storage_reference":fixture,"storage_files":files,"seconds":round(time.monotonic()-started,3),"encrypted":False,"production_qualified":False}
    evidence = ROOT / "data/remediation-20261010/evidence"
    evidence.mkdir(parents=True,exist_ok=True)
    (evidence / "final-backup-restore.json").write_text(json.dumps(record,indent=2)+"\n")
    print("Restored synthetic database into new target:",restore,"tables:",len(counts),"hashed files:",len(files))

if __name__ == "__main__":
    main()
