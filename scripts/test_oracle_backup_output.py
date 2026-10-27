"""Test the real decoder with synthetic cryptography and in-memory S3 responses."""

import base64
import json
import os
import shutil
import subprocess
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")
FIXTURE = r"""
import crypto from 'node:crypto';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const pair=crypto.generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const keyId=hash(pair.publicKey),master=crypto.randomBytes(32),key=crypto.randomBytes(32),dump=Buffer.concat([Buffer.from('PGDMP'),Buffer.alloc(524288,120)]);
const encrypt=(key,body,aad)=>{const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);if(aad)cipher.setAAD(aad);return {nonce,body:Buffer.concat([cipher.update(body),cipher.final()]),tag:cipher.getAuthTag()};};
const escrow=encrypt(master,Buffer.from(pair.privateKey));
const meta={format:'onesa-portal-backup-v1',key_id:keyId,database_sha256:hash(dump),objects:0};
const payload=Buffer.from(JSON.stringify({dump:dump.toString('base64'),objects:[],manifest:[{table:'synthetic',count:1,hash:'synthetic'}],session_key:'synthetic-session-key-'.repeat(4)}));
const sealed=encrypt(key,payload,Buffer.from(JSON.stringify(meta)));
const archive=Buffer.from(JSON.stringify({meta,wrapped_key:crypto.publicEncrypt({key:pair.publicKey,oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},key).toString('base64'),nonce:sealed.nonce.toString('base64'),tag:sealed.tag.toString('base64'),body:sealed.body.toString('base64')}));
const object='.onesa-portal-backups/v1/'+'a'.repeat(32)+'.json';
console.log(JSON.stringify({endpoint:'https://br-red-morning-b9d1sxnz.storage.c-7.eu-central-1.aws.neon.tech',region:'synthetic',bucket:'synthetic',access:'synthetic',secret:'synthetic',object_key:object,key_id:keyId,ciphertext_sha256:hash(archive),master:master.toString('base64'),fixture_objects:{[object]:archive.toString('base64'),['.onesa-portal-backups/v1/keys/'+keyId+'.enc']:Buffer.concat([escrow.nonce,escrow.tag,escrow.body]).toString('base64')}}));
"""
MOCK = r"""
void process.stdout; // Initialize the nonblocking pipe before decoding.
class GetObjectCommand { constructor(input){this.input=input;} }
class S3Client { async send(command){const bytes=Buffer.from(x.fixture_objects[command.input.Key],'base64');return {ContentLength:bytes.length,Body:{transformToByteArray:async()=>bytes}};} }
"""
IMPORT = "import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3';"


@unittest.skipUnless(NODE, "Node is required for the synthetic decoder control")
class BackupOutputTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(
            subprocess.check_output(
                [NODE, "--input-type=module", "-e", FIXTURE], timeout=20
            )
        )
        cls.source = (ROOT / "scripts/oracle_backup_open.mjs").read_text()

    def decode(self, request, source=None):
        script = source or self.source
        self.assertEqual(script.count(IMPORT), 1)
        # Only the external provider is mocked; all decoder checks run unchanged.
        script = script.replace(IMPORT, MOCK)
        child = subprocess.Popen(
            [NODE, "--input-type=module", "-e", script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            child.stdin.write(json.dumps(request).encode())
            child.stdin.close()
            child.stdin = None
            time.sleep(0.15)  # Put backpressure on this owned pipe.
            output, error = child.communicate(timeout=10)
            return child.returncode, output, error
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate()

    def test_large_payload_survives_nonblocking_pipe(self):
        code, output, _ = self.decode(self.fixture)
        self.assertEqual(code, 0)
        recovered = json.loads(output)
        self.assertEqual(
            base64.b64decode(recovered["dump"], validate=True),
            b"PGDMP" + b"x" * 524288,
        )
        self.assertTrue(recovered["checks"]["tampered_archive_rejected"])
        self.assertTrue(recovered["checks"]["key_recovered_from_off_instance_escrow"])

    def test_old_writer_reproduces_truncation(self):
        # Reproduce the old output boundary without needing history in shallow CI.
        lines = self.source.splitlines()
        writers = [
            i
            for i, line in enumerate(lines)
            if "process.stdout.write(JSON.stringify" in line
        ]
        self.assertEqual(len(writers), 1)
        lines[writers[0]] = "fs.writeFileSync(1,JSON.stringify(payload));"
        old = "\n".join(lines)
        code, output, _ = self.decode(self.fixture, old)
        self.assertNotEqual(code, 0)
        self.assertLess(len(output), 524288)
        with self.assertRaises((ValueError, UnicodeError)):
            json.loads(output)

    def test_corrupted_archive_rejected_before_output(self):
        request = json.loads(json.dumps(self.fixture))
        key = request["object_key"]
        body = bytearray(base64.b64decode(request["fixture_objects"][key]))
        body[-1] ^= 1
        request["fixture_objects"][key] = base64.b64encode(body).decode()
        code, output, _ = self.decode(request)
        self.assertNotEqual(code, 0)
        self.assertEqual(output, b"")

    def test_wrong_escrow_key_rejected_before_output(self):
        request = {**self.fixture, "master": base64.b64encode(b"x" * 32).decode()}
        code, output, _ = self.decode(request)
        self.assertNotEqual(code, 0)
        self.assertEqual(output, b"")


STORE_IMPORT = "import {S3Client,PutObjectCommand,GetObjectCommand,ListObjectsV2Command,DeleteObjectCommand} from '@aws-sdk/client-s3';"
STORE_MOCK = r"""
void process.stdout; // Exercise Node's real nonblocking output boundary.
class GetObjectCommand { constructor(input){this.input=input;} }
class S3Client { async send(command){
 if(!(command instanceof GetObjectCommand))throw Error('Read-only fixture');
 const bytes=Buffer.from(input.fixture_objects[command.input.Key],'base64');
 return {ContentLength:input.reported_length??bytes.length,Body:{transformToByteArray:async()=>bytes}};
} }
class PutObjectCommand { constructor(){throw Error('Read-only fixture');} }
class ListObjectsV2Command { constructor(){throw Error('Read-only fixture');} }
class DeleteObjectCommand { constructor(){throw Error('Read-only fixture');} }
"""
STREAM_WRITER = "await new Promise((resolve,reject)=>process.stdout.write(bytes,error=>error?reject(error):resolve()));"


@unittest.skipUnless(NODE, "Node is required for the synthetic transport control")
class BackupTransportOutputTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(
            subprocess.check_output(
                [NODE, "--input-type=module", "-e", FIXTURE], timeout=20
            )
        )
        cls.source = (ROOT / "scripts/oracle_backup_store.mjs").read_text()

    def read(self, changes=None, source=None):
        request = {
            "action": "read",
            "key": self.fixture["object_key"],
            "fixture_objects": self.fixture["fixture_objects"],
            **(changes or {}),
        }
        script = source or self.source
        self.assertEqual(script.count(STORE_IMPORT), 1)
        child = subprocess.Popen(
            [
                NODE,
                "--input-type=module",
                "-e",
                script.replace(STORE_IMPORT, STORE_MOCK),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={
                "PATH": os.environ.get("PATH", ""),
                "S3_ENDPOINT": self.fixture["endpoint"],
                "S3_REGION": "synthetic",
                "S3_BUCKET": "synthetic",
            },
        )
        try:
            child.stdin.write(json.dumps(request).encode())
            child.stdin.close()
            child.stdin = None
            time.sleep(0.15)
            output, error = child.communicate(timeout=10)
            return child.returncode, output, error
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate()

    def test_complete_ciphertext_survives_real_pipe_backpressure(self):
        code, output, _ = self.read()
        self.assertEqual(code, 0)
        self.assertEqual(
            output,
            base64.b64decode(
                self.fixture["fixture_objects"][self.fixture["object_key"]]
            ),
        )

    def test_former_synchronous_transport_reproduces_truncation(self):
        self.assertEqual(self.source.count(STREAM_WRITER), 1)
        code, output, _ = self.read(
            source=self.source.replace(STREAM_WRITER, "fs.writeFileSync(1,bytes);")
        )
        self.assertNotEqual(code, 0)
        self.assertLess(len(output), 524288)

    def test_oversized_missing_and_out_of_scope_objects_produce_no_bytes(self):
        for changes in [
            {"reported_length": 128 * 1024 * 1024 + 1},
            {"fixture_objects": {}},
            {"key": "unapproved-object"},
        ]:
            with self.subTest(changes=list(changes)):
                code, output, _ = self.read(changes)
                self.assertNotEqual(code, 0)
                self.assertEqual(output, b"")


if __name__ == "__main__":
    unittest.main()
