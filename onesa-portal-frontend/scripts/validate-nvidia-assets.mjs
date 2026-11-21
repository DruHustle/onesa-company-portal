import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const revision = '4763fbfaa4f8e97658e68b57d01b4c86659e08b5';
export function validateGlb(bytes) {
  assert.ok(bytes.length >= 28 && bytes.length <= 2_000_000, 'bounded GLB');
  assert.equal(bytes.toString('utf8', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(4), 2); assert.equal(bytes.readUInt32LE(8), bytes.length);
  const size = bytes.readUInt32LE(12); assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  assert.ok(size > 0 && size % 4 === 0 && 28 + size <= bytes.length);
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + size));
  assert.equal(json.asset.version, '2.0');
  for (const field of ['animations', 'skins', 'images', 'textures', 'extensionsRequired']) assert.equal((json[field] || []).length, 0, `static untextured model: ${field}`);
  assert.equal(json.buffers.length, 1); assert.equal(json.buffers[0].uri, undefined);
  assert.equal(bytes.readUInt32LE(24 + size), 0x004e4942);
  const binaryLength = bytes.readUInt32LE(20 + size);
  assert.equal(binaryLength + size + 28, bytes.length);
  assert.ok(json.buffers[0].byteLength <= binaryLength && binaryLength - json.buffers[0].byteLength < 4);
  let triangles = 0;
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
    assert.equal(primitive.mode ?? 4, 4);
    const count = json.accessors[primitive.indices]?.count;
    assert.ok(Number.isSafeInteger(count) && count > 0 && count % 3 === 0);
    triangles += count / 3;
  }
  assert.ok(triangles > 0 && triangles <= 60000, 'bounded triangle count');
  return {json, triangles};
}

export async function validateCatalog(root, catalog) {
  assert.equal(catalog.schemaVersion, 1); assert.equal(catalog.catalogId, 'onesa-nvidia-simready-reference-v1');
  assert.equal(catalog.assets.length, 3); const ids = new Set();
  for (const asset of catalog.assets) {
    assert.match(asset.id, /^nvidia-[a-z-]+$/); assert.ok(!ids.has(asset.id)); ids.add(asset.id);
    assert.equal(asset.sourceRevision, revision); assert.equal(asset.author, 'NVIDIA');
    assert.equal(asset.license, 'CC-BY-4.0'); assert.equal(asset.visualOnly, true);
    assert.equal(asset.unit, 'm'); assert.equal(asset.upAxis, 'Y');
    assert.equal(asset.sourceUrl, `https://huggingface.co/datasets/nvidia/simready-assets/tree/${revision}/${asset.sourceAssetId}`);
    for (const key of ['glb', 'thumbnail', 'licenseFile', 'sourceFile']) {
      const ref = asset[key];
      assert.match(ref.path, /^[a-z-]+\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/);
      assert.equal(ref.path.split('/')[0], asset.id);
      assert.match(ref.sha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(ref.byteLength) && ref.byteLength > 0 && ref.byteLength <= 2_000_000);
      const bytes = await readFile(join(root, ref.path));
      assert.equal(bytes.length, ref.byteLength); assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.sha256);
      if (key === 'glb') assert.equal(validateGlb(bytes).triangles, asset.triangles);
      if (key === 'licenseFile') assert.ok(bytes.includes(Buffer.from('Creative Commons Attribution 4.0 International')));
      if (key === 'sourceFile') {
        const source = JSON.parse(bytes);
        assert.equal(source.revision, revision); assert.equal(source.author, 'NVIDIA');
        assert.equal(source.assetId, asset.sourceAssetId); assert.equal(source.license, 'CC-BY-4.0');
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../public/models/nvidia/', import.meta.url));
  const catalog = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  const frontend = JSON.parse(await readFile(new URL('../src/config/nvidia-reference-assets.json', import.meta.url), 'utf8'));
  assert.deepEqual(catalog, frontend, 'public and compiled catalog must match');
  assert.equal(
    await readFile(new URL('../public/licenses/three.txt', import.meta.url), 'utf8'),
    await readFile(new URL('../node_modules/three/LICENSE', import.meta.url), 'utf8'),
    'The browser distribution must retain the exact Three.js license notice',
  );
  await validateCatalog(root, catalog);
  console.log('Three pinned NVIDIA assets: byte integrity, provenance, licenses and static GLB budgets passed.');
}
