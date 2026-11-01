import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {LoadingManager, Box3, Vector3} from 'three';
import {validateCatalog, validateGlb} from '../scripts/validate-nvidia-assets.mjs';
const root = fileURLToPath(new URL('../public/models/nvidia/', import.meta.url));
const catalog = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
test('three real NVIDIA assets pass integrity, license and geometry budgets', () => validateCatalog(root, catalog));
test('mutable provenance, unsafe paths, duplicate IDs and corrupt hashes fail closed', async () => {
  for (const mutate of [c => {c.assets[0].sourceRevision = 'main';}, c => {c.assets[0].glb.path = '../other.glb';}, c => {c.assets[1].id = c.assets[0].id;}, c => {c.assets[0].glb.sha256 = '0'.repeat(64);}, c => {c.assets[0].visualOnly = false;}]) {
    const changed = structuredClone(catalog); mutate(changed); await assert.rejects(validateCatalog(root, changed));
  }
});
test('truncated and malformed GLBs are rejected before renderer admission', async () => {
  const bytes = await readFile(join(root, catalog.assets[0].glb.path));
  assert.throws(() => validateGlb(bytes.subarray(0, -4)));
  const changed = Buffer.from(bytes); changed.writeUInt32LE(3, 4); assert.throws(() => validateGlb(changed));
});
for (const asset of catalog.assets) test(`${asset.id} loads in the real GLTF parser without external resources`, async () => {
  const bytes = await readFile(join(root, asset.glb.path));
  const manager = new LoadingManager(); manager.setURLModifier(() => {throw new Error('external resource forbidden');});
  const result = await new GLTFLoader(manager).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const size = new Box3().setFromObject(result.scene).getSize(new Vector3());
  assert.ok([size.x, size.y, size.z].every(value => Number.isFinite(value) && value > 0));
  result.scene.traverse(node => {if (node.isMesh) {node.geometry.dispose(); for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose();}});
});
