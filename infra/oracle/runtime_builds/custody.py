#!/usr/bin/env python3
"""Retain pinned vendor source/notice custody without extracting or executing it."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile

HERE = Path(__file__).resolve().parent
MAX_FILE = 180 * 1024**2
MAX_TOTAL = 1024**3


def require(condition, message):
    if not condition:
        raise ValueError(message)


def relative(name):
    require(isinstance(name, str), "Invalid custody path")
    p = PurePosixPath(name)
    require(name and p.parts and not p.is_absolute() and str(p) == name and '..' not in p.parts
            and '\\' not in name and not any(ord(c) < 32 for c in name), "Unsafe custody path")
    return p


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def validate_manifest(raw, lock, inventory_raw):
    require(digest(raw) == lock['vendor_custody_sha256'], "Vendor custody manifest differs")
    require(digest(inventory_raw) == lock['vendor_inventory_sha256'], "Vendor inventory differs")
    m = json.loads(raw)
    require(m['schema_version'] == 1 and m['vendor_sha256'] == lock['vendor_runtime']['sha256']
            and m['payload'] == lock['vendor_runtime']['payload']
            and m['vendor_inventory_sha256'] == lock['vendor_inventory_sha256'], "Vendor custody identity differs")
    files = {}
    require(isinstance(m['files'], list) and 0 < len(m['files']) < 4096, "Invalid custody file inventory")
    for row in m['files']:
        name = str(relative(row['path']))
        require(name not in files and name != 'vendor-custody.lock.json', "Duplicate custody file")
        require(row['kind'] in {'source', 'notice', 'recipe', 'provenance'}
                and type(row['bytes']) is int and 0 < row['bytes'] <= MAX_FILE
                and re.fullmatch(r'[a-f0-9]{64}', row['sha256']), "Invalid custody file bounds or hash")
        files[name] = row
    require(sum(r['bytes'] for r in files.values()) <= MAX_TOTAL, "Custody bundle exceeds bounds")
    groups = m['groups']
    require(isinstance(groups, dict) and groups, "Missing custody groups")
    for group in groups.values():
        for key, kind in [('source', 'source'), ('notices', 'notice')]:
            require(isinstance(group[key], list) and group[key], "Missing source or notices")
            require(len(group[key]) == len(set(group[key])), "Duplicate group input")
            require(all(n in files and files[n]['kind'] == kind for n in group[key]), "Missing source or notices")
        require(all(n in groups for n in group.get('recipe_groups', [])), "Unknown recipe group")
    require(set(m['userspace_dependency_groups']) == {g for g in groups if g.startswith('buildroot/')},
            "Userspace dependency closure differs")
    inventory_rows = json.loads(inventory_raw)['files']
    inventory = {r['path']: r for r in inventory_rows}
    require(len(inventory_rows) == len(inventory), "Duplicate vendor inventory path")
    coverage = m['coverage']
    require(len(coverage) == len(inventory) and len({r['path'] for r in coverage}) == len(coverage)
            and {r['path'] for r in coverage} == set(inventory), "Vendor custody coverage differs")
    prefix = 'data/' + m['payload'] + '/bin/'
    for row in coverage:
        path, mode = row['path'], row['disposition']
        relative(path)
        if path == 'data/.lock':
            require(mode == 'extraction-state' and inventory[path]['bytes'] == 0, "Invalid extraction-state exception")
            continue
        require(path.startswith(prefix), "Unexpected vendor payload path")
        name = path.removeprefix(prefix)
        if name in lock['components']:
            require(mode == 'replaced' and row.get('component') == name, "Invalid replacement exception")
            continue
        require(mode == ('generated' if name in {'.links', '.sha256sums'} else 'retained'),
                "Invalid vendor custody exception")
        require(row.get('groups') and all(g in groups for g in row['groups']), "Missing vendor source coverage")
        if name == 'cni':
            require({'cni', 'flannel', 'cni-go-stdlib', 'k3s'} <= set(row['groups'])
                    and {g for g in groups if g.startswith('cni-modules/')} <= set(row['groups']),
                    "Missing separate CNI custody")
            proof = m['cni_provenance']
            require(proof['binary_sha256'] == inventory[path]['sha256']
                    and proof['revision'] == groups['cni']['revision']
                    and proof['go'] == groups['cni-go-stdlib']['version']
                    and proof['build_info'] in files and files[proof['build_info']]['kind'] == 'provenance',
                    "CNI provenance differs")
        if name == 'check-config':
            require({'k3s', 'check-config-moby', 'check-config-lxc'} <= set(row['groups']),
                    "Missing check-config custody")
            script = files.get('recipes/check-config.sh', {})
            require(script.get('sha256') == inventory[path]['sha256']
                    and script.get('bytes') == inventory[path]['bytes'], "check-config source bytes differ")
    return m


def read_input(root, row):
    """Use descriptor-relative no-follow opens, including every directory component."""
    path = relative(row['path'])
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in path.parts[:-1]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        source = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(source, 'rb') as stream:
            info = os.fstat(stream.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_size == row['bytes'], "Custody input size/type differs")
            raw = stream.read(row['bytes'] + 1)
        require(len(raw) == row['bytes'] and digest(raw) == row['sha256'], "Custody input digest differs")
        return raw
    finally:
        os.close(fd)


def verify_bundle(path, manifest, manifest_raw):
    """Read back every member and hash original bytes without filesystem extraction."""
    expected = {r['path']: r for r in manifest['files']}
    expected['vendor-custody.lock.json'] = {'bytes': len(manifest_raw), 'sha256': digest(manifest_raw)}
    seen = set()
    with tarfile.open(path, 'r|gz') as archive:
        for member in archive:
            require(member.name in expected and member.name not in seen and member.isfile(),
                    "Custody archive member differs")
            row = expected[member.name]
            require(member.size == row['bytes'], "Custody archive member size differs")
            checksum = hashlib.sha256()
            with archive.extractfile(member) as stream:
                for chunk in iter(lambda: stream.read(1024**2), b''):
                    checksum.update(chunk)
            require(checksum.hexdigest() == row['sha256'], "Custody archive member digest differs")
            seen.add(member.name)
    require(seen == set(expected), "Custody archive coverage differs")


def retain_custody(lock, inputs, output, *, manifest_path=None, inventory_path=None):
    manifest_path = manifest_path or HERE / 'vendor-custody.lock.json'
    inventory_path = inventory_path or HERE / 'vendor-runtime-files.json'
    raw = manifest_path.read_bytes()
    m = validate_manifest(raw, lock, inventory_path.read_bytes())
    require(inputs.is_absolute() and inputs.is_dir() and not inputs.is_symlink(), "Ordinary absolute custody inputs required")
    require(output.is_absolute() and output.is_dir() and not output.is_symlink(), "Ordinary absolute custody output required")
    target, pending = output / 'vendor-custody.tar.gz', output / '.vendor-custody.tar.gz.partial'
    require(not target.exists() and not target.is_symlink(), "Existing custody output refused")
    created = False
    try:
        with pending.open('xb') as stream:
            created = True
            with gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.USTAR_FORMAT) as archive:
                    for row in sorted(m['files'], key=lambda r: r['path']):
                        data = read_input(inputs, row)
                        info = tarfile.TarInfo(row['path'])
                        info.size, info.mode = len(data), 0o644
                        archive.addfile(info, io.BytesIO(data))
                    info = tarfile.TarInfo('vendor-custody.lock.json')
                    info.size, info.mode = len(raw), 0o644
                    archive.addfile(info, io.BytesIO(raw))
            stream.flush()
            os.fsync(stream.fileno())
        verify_bundle(pending, m, raw)
        # Link without overwriting an output created by another process.
        os.link(pending, target)
    finally:
        if created:
            pending.unlink()
    checksum = hashlib.sha256()
    with target.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024**2), b''):
            checksum.update(chunk)
    return {'status': 'CUSTODY_VERIFIED_NOT_LEGAL_APPROVAL', 'manifest_sha256': digest(raw),
            'archive': target.name, 'archive_sha256': checksum.hexdigest(), 'archive_bytes': target.stat().st_size,
            'files': len(m['files']), 'vendor_files_covered': len(m['coverage']), 'archive_readback': 'PASS',
            'limitations': m['limitations']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    require(args.output.is_absolute() and not args.output.exists(), "New absolute output directory required")
    args.output.mkdir(mode=0o700)
    result = retain_custody(json.loads((HERE / 'sources.lock.json').read_text()), args.inputs, args.output)
    (args.output / 'vendor-custody-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
