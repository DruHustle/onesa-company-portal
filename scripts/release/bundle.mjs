// Encrypt the reviewed Vercel prebuilt output; never upload plain build output.
// Node's built-in AES-256-GCM authenticates both the archive and candidate binding.
import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const [mode, directory] = process.argv.slice(2);
const keyText = process.env.RELEASE_BUILD_KEY || '';
if (!/^[a-f0-9]{64}$/.test(keyText)) throw new Error('RELEASE_BUILD_KEY must be a privately generated 32-byte hex key');
const key = Buffer.from(keyText, 'hex');
const binding = Buffer.from(JSON.stringify({repository: process.env.GITHUB_REPOSITORY, commit: process.env.GITHUB_SHA}));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (mode === 'pack') {
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const archive = join(directory, 'private.tar');
  const result = spawnSync('tar', ['-cf', archive, '-C', '.vercel', 'output'], {stdio: 'pipe'});
  if (result.status !== 0) throw new Error('Cannot archive Vercel output');
  try {
    const plain = readFileSync(archive);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(binding);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    writeFileSync(join(directory, 'bundle.enc'), Buffer.concat([nonce, cipher.getAuthTag(), encrypted]), {mode: 0o600});
    writeFileSync(join(directory, 'record.json'), JSON.stringify({schema_version: 1, repository: process.env.GITHUB_REPOSITORY, candidate_commit: process.env.GITHUB_SHA, workflow_run_id: Number(process.env.GITHUB_RUN_ID), build_sha256: hash(plain), encrypted_sha256: hash(readFileSync(join(directory, 'bundle.enc'))), format: 'aes-256-gcm/tar', source_sha256: process.env.SOURCE_SHA256, target_environment: 'Production'}, null, 2));
  } finally { rmSync(archive, {force: true}); }
} else if (mode === 'unpack') {
  const record = JSON.parse(readFileSync(join(directory, 'record.json')));
  if (record.repository !== process.env.GITHUB_REPOSITORY || record.candidate_commit !== process.env.GITHUB_SHA || record.target_environment !== 'Production') throw new Error('Build binding mismatch');
  const bytes = readFileSync(join(directory, 'bundle.enc'));
  if (hash(bytes) !== record.encrypted_sha256) throw new Error('Encrypted build altered');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0,12)); decipher.setAAD(binding); decipher.setAuthTag(bytes.subarray(12,28));
  const plain = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  if (hash(plain) !== record.build_sha256) throw new Error('Reviewed build digest mismatch');
  const archive = join(directory, 'private.tar'); writeFileSync(archive, plain, {mode: 0o600});
  try {
    const listing = spawnSync('tar', ['-tf', archive], {encoding: 'utf8'});
    if (listing.status !== 0 || listing.stdout.split('\n').filter(Boolean).some(path => !path.startsWith('output/') || path.split('/').includes('..'))) throw new Error('Unexpected build archive paths');
    // This archive is authenticated and comes exclusively from the owner main build workflow.
    mkdirSync('.vercel', {recursive: true, mode: 0o700});
    if (spawnSync('tar', ['-xf', archive, '-C', '.vercel'], {stdio:'pipe'}).status !== 0) throw new Error('Cannot restore reviewed output');
  } finally { rmSync(archive, {force: true}); }
} else { throw new Error('Choose pack or unpack'); }
