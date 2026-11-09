"""Real filesystem/archive refusal tests; no upstream downloads or execution."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('vendor_custody', Path(__file__).with_name('custody.py'))
custody = importlib.util.module_from_spec(spec)
spec.loader.exec_module(custody)


class CustodyTests(unittest.TestCase):
    def test_checked_in_manifest_covers_the_pinned_vendor_inventory(self):
        here = Path(__file__).parent
        lock = json.loads((here / 'sources.lock.json').read_text())
        manifest = custody.validate_manifest((here / 'vendor-custody.lock.json').read_bytes(), lock,
                                             (here / 'vendor-runtime-files.json').read_bytes())
        self.assertEqual(len(manifest['coverage']), 31)
        self.assertEqual(len(manifest['userspace_dependency_groups']), 43)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.inputs, self.output = self.root / 'inputs', self.root / 'output'
        self.inputs.mkdir()
        self.output.mkdir()
        self.payload = 'a' * 64
        self.prefix = 'data/' + self.payload + '/bin/'
        self.inventory = {'files': [
            {'path': 'data/.lock', 'bytes': 0}, {'path': self.prefix + 'tool', 'bytes': 1},
            {'path': self.prefix + 'core', 'bytes': 1}, {'path': self.prefix + '.links', 'bytes': 1}]}
        self.manifest_path, self.inventory_path = self.root / 'manifest.json', self.root / 'inventory.json'
        files = []
        self.originals = {'sources/original.tar': b'opaque original source archive',
                          'notices/COPYING': b'Original notice\n', 'recipes/build.sh': b'exit 0\n'}
        for name, raw in self.originals.items():
            target = self.inputs / name
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(raw)
            files.append({'path': name, 'bytes': len(raw), 'sha256': custody.digest(raw),
                          'kind': {'sources': 'source', 'notices': 'notice', 'recipes': 'recipe'}[name.split('/')[0]]})
        self.lock = {'vendor_runtime': {'sha256': 'b' * 64, 'payload': self.payload}, 'components': {'core': {}}}
        self.manifest = {'schema_version': 1, 'vendor_sha256': 'b' * 64, 'payload': self.payload,
                         'files': files, 'groups': {'tool': {'source': ['sources/original.tar'], 'notices': ['notices/COPYING']}},
                         'coverage': [{'path': 'data/.lock', 'disposition': 'extraction-state'},
                                      {'path': self.prefix + 'tool', 'disposition': 'retained', 'groups': ['tool']},
                                      {'path': self.prefix + 'core', 'disposition': 'replaced', 'component': 'core'},
                                      {'path': self.prefix + '.links', 'disposition': 'generated', 'groups': ['tool']}],
                         'userspace_dependency_groups': [], 'limitations': ['No legal-completeness or runtime qualification claim.']}
        self.pin()

    def pin(self):
        raw = (json.dumps(self.inventory) + '\n').encode()
        self.inventory_path.write_bytes(raw)
        self.lock['vendor_inventory_sha256'] = custody.digest(raw)
        self.manifest['vendor_inventory_sha256'] = custody.digest(raw)
        raw = (json.dumps(self.manifest) + '\n').encode()
        self.manifest_path.write_bytes(raw)
        self.lock['vendor_custody_sha256'] = custody.digest(raw)

    def retain(self, output=None):
        return custody.retain_custody(self.lock, self.inputs, output or self.output,
                                      manifest_path=self.manifest_path, inventory_path=self.inventory_path)

    def no_partial_result(self):
        self.assertEqual(list(self.output.iterdir()), [])

    def test_retains_original_bytes_and_manifest_in_deterministic_archive(self):
        result = self.retain()
        self.assertEqual(result['status'], 'CUSTODY_VERIFIED_NOT_LEGAL_APPROVAL')
        with tarfile.open(self.output / result['archive'], 'r:gz') as archive:
            self.assertEqual(set(archive.getnames()), set(self.originals) | {'vendor-custody.lock.json'})
            for name, raw in self.originals.items():
                self.assertEqual(archive.extractfile(name).read(), raw)
            self.assertEqual(archive.extractfile('vendor-custody.lock.json').read(), self.manifest_path.read_bytes())
            self.assertTrue(all(m.isfile() and m.uid == 0 and m.mtime == 0 for m in archive))
        other = self.root / 'other'
        other.mkdir()
        self.assertEqual(self.retain(other)['archive_sha256'], result['archive_sha256'])

    def test_missing_source_or_notice_never_leaves_completed_bundle(self):
        for name in ['sources/original.tar', 'notices/COPYING']:
            p = self.inputs / name
            p.unlink()
            with self.assertRaises(FileNotFoundError):
                self.retain()
            self.no_partial_result()
            p.write_bytes(self.originals[name])

    def test_same_size_tampering_fails_hash_and_removes_partial_bundle(self):
        p = self.inputs / 'notices/COPYING'
        p.write_bytes(b'X' * p.stat().st_size)
        with self.assertRaisesRegex(ValueError, 'digest differs'):
            self.retain()
        self.no_partial_result()

    def test_manifest_or_vendor_inventory_tampering_fails(self):
        for p in [self.manifest_path, self.inventory_path]:
            original = p.read_bytes()
            p.write_bytes(original + b' ')
            with self.assertRaisesRegex(ValueError, 'differs'):
                self.retain()
            self.no_partial_result()
            p.write_bytes(original)

    def test_unsafe_paths_are_rejected_even_with_a_matching_manifest_hash(self):
        original = copy.deepcopy(self.manifest)
        for path in ['../escape', '/absolute', 'sources/../escape', 'sources//file', 'sources/./file', 'sources\\file', 'sources/file\n']:
            self.manifest = copy.deepcopy(original)
            self.manifest['files'][0]['path'] = path
            self.pin()
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, 'Unsafe custody path'):
                self.retain()
            self.no_partial_result()

    def test_symlink_files_and_directory_components_are_refused(self):
        p = self.inputs / 'sources/original.tar'
        outside = self.root / 'outside'
        p.rename(outside)
        p.symlink_to(outside)
        with self.assertRaises(OSError):
            self.retain()
        self.no_partial_result()
        p.unlink()
        (self.inputs / 'sources').rmdir()
        directory = self.root / 'elsewhere'
        directory.mkdir()
        outside.rename(directory / 'original.tar')
        (self.inputs / 'sources').symlink_to(directory, target_is_directory=True)
        with self.assertRaises(OSError):
            self.retain()
        self.no_partial_result()

    def test_nonregular_input_is_refused_without_blocking(self):
        p = self.inputs / 'notices/COPYING'
        p.unlink()
        os.mkfifo(p)
        with self.assertRaisesRegex(ValueError, 'size/type differs'):
            self.retain()
        self.no_partial_result()

    def test_missing_duplicate_and_extra_coverage_are_refused(self):
        original = copy.deepcopy(self.manifest)
        variants = [original['coverage'][:-1], original['coverage'] + [original['coverage'][0]],
                    [{**r, 'path': self.prefix + 'unknown'} if i == 1 else r for i, r in enumerate(original['coverage'])]]
        for coverage in variants:
            self.manifest = copy.deepcopy(original)
            self.manifest['coverage'] = coverage
            self.pin()
            with self.assertRaisesRegex(ValueError, 'coverage differs'):
                self.retain()
            self.no_partial_result()

    def test_new_vendor_file_requires_coverage(self):
        self.inventory['files'].append({'path': self.prefix + 'new-tool', 'bytes': 1})
        self.pin()
        with self.assertRaisesRegex(ValueError, 'coverage differs'):
            self.retain()

    def test_retained_tool_cannot_be_labeled_as_an_exception(self):
        for mode in ['extraction-state', 'replaced', 'generated']:
            self.manifest['coverage'][1]['disposition'] = mode
            self.pin()
            with self.assertRaisesRegex(ValueError, 'Invalid vendor custody exception'):
                self.retain()

    def test_missing_group_notices_and_unknown_dependencies_are_refused(self):
        self.manifest['groups']['tool']['notices'] = []
        self.pin()
        with self.assertRaisesRegex(ValueError, 'Missing source or notices'):
            self.retain()
        self.manifest['groups']['tool']['notices'] = ['notices/COPYING']
        self.manifest['userspace_dependency_groups'] = ['buildroot/missing']
        self.pin()
        with self.assertRaisesRegex(ValueError, 'closure differs'):
            self.retain()

    def test_cni_and_check_config_need_their_own_custody(self):
        for name, message in [('cni', 'Missing separate CNI'), ('check-config', 'Missing check-config')]:
            self.inventory['files'][1]['path'] = self.prefix + name
            self.manifest['coverage'][1]['path'] = self.prefix + name
            self.pin()
            with self.assertRaisesRegex(ValueError, message):
                self.retain()

    def test_size_limits_and_existing_output_are_enforced(self):
        self.manifest['files'][0]['bytes'] = custody.MAX_FILE + 1
        self.pin()
        with self.assertRaisesRegex(ValueError, 'bounds or hash'):
            self.retain()
        self.manifest['files'][0]['bytes'] = len(self.originals['sources/original.tar'])
        self.pin()
        self.retain()
        before = (self.output / 'vendor-custody.tar.gz').read_bytes()
        with self.assertRaisesRegex(ValueError, 'Existing custody output refused'):
            self.retain()
        self.assertEqual((self.output / 'vendor-custody.tar.gz').read_bytes(), before)

    def test_archive_readback_detects_changed_or_missing_original_bytes(self):
        self.retain()
        path = self.output / 'vendor-custody.tar.gz'
        rows = []
        with tarfile.open(path, 'r:gz') as archive:
            for member in archive:
                rows.append((member, archive.extractfile(member).read()))
        import io
        with tarfile.open(path, 'w:gz') as archive:
            for member, raw in rows:
                if member.name == 'notices/COPYING':
                    raw = b'X' * len(raw)
                archive.addfile(member, io.BytesIO(raw))
        with self.assertRaisesRegex(ValueError, 'archive member digest differs'):
            custody.verify_bundle(path, self.manifest, self.manifest_path.read_bytes())
        with tarfile.open(path, 'w:gz') as archive:
            for member, raw in rows[:-1]:
                archive.addfile(member, io.BytesIO(raw))
        with self.assertRaisesRegex(ValueError, 'archive coverage differs'):
            custody.verify_bundle(path, self.manifest, self.manifest_path.read_bytes())


if __name__ == '__main__':
    unittest.main()
