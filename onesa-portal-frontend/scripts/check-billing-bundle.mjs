import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const base = new URL('../src/features/account/billing/vendor/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8'));
assert.equal(manifest.name, 'onesa-company-billing-web');
assert.equal(manifest.version, '0.1.0');
assert.deepEqual(Object.keys(manifest.files).sort(), ['billing.css', 'client.mjs', 'money.mjs', 'mount.d.mts', 'mount.mjs']);
for (const [name, record] of Object.entries(manifest.files)) {
  const bytes = await readFile(new URL(name, base));
  assert.equal(bytes.length, record.bytes, `${name}: byte length changed; review and repin this vendored version`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256, `${name}: reviewed bytes changed`);
}
process.stdout.write('Verified Onesa billing web 0.1.0 vendored bytes\n');
