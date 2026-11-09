#!/usr/bin/env python3
"""Rebuild the pinned containerd-only ARM64 K3s candidate; never install/publish."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tarfile
import urllib.request
import zipfile
from custody import retain_custody

HERE = Path(__file__).resolve().parent
MAX_SOURCE = 32 * 1024**2
MAX_EXTRACTED = 512 * 1024**2


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def relative(name):
    path = PurePosixPath(name)
    require(name and not path.is_absolute() and ".." not in path.parts
            and "\\" not in name and "\x00" not in name
            and str(path) == name.rstrip("/"), "Unsafe archive path")
    return path


def unpack(raw, destination, kind, prefix):
    """Extract bounded regular source files, rejecting links and duplicate names."""
    prefix = relative(prefix)
    seen, total = set(), 0

    def output(name, size, directory, mode, reader):
        nonlocal total
        path = relative(name)
        require(path == prefix or prefix in path.parents, "Source prefix differs")
        if path == prefix:
            require(directory, "Source root is not a directory")
            return
        path = path.relative_to(prefix)
        require(path not in seen, "Duplicate archive member")
        seen.add(path)
        total += size
        require(0 <= size <= MAX_EXTRACTED and total <= MAX_EXTRACTED, "Source archive exceeds bounds")
        target = destination / path
        if directory:
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                shutil.copyfileobj(reader(), stream)
            require(target.stat().st_size == size, "Truncated archive member")
            target.chmod(0o755 if mode & 0o111 else 0o644)

    if kind == "tar":
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
            for member in archive:
                require(member.isfile() or member.isdir(), "Source archive links/devices refused")
                output(member.name, member.size, member.isdir(), member.mode,
                       lambda m=member: archive.extractfile(m))
    elif kind == "zip":
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            for member in archive.infolist():
                mode = member.external_attr >> 16
                require(not stat.S_ISLNK(mode) and (stat.S_IFMT(mode) in {0, stat.S_IFREG, stat.S_IFDIR}),
                        "Source archive links/devices refused")
                output(member.filename, member.file_size, member.is_dir(), mode,
                       lambda m=member: archive.open(m))
    else:
        raise ValueError("Unknown source archive format")
    require(seen, "Empty source archive")


def fetch(url, expected, target, retained=None, limit=MAX_SOURCE):
    if retained is not None:
        require(retained.is_file() and not retained.is_symlink(), "Retained input must be a regular file")
        with retained.open("rb") as source:
            raw = source.read(limit + 1)
    else:
        require(url.startswith("https://"), "HTTPS source required")
        with urllib.request.urlopen(url, timeout=45) as response:
            require(response.url.startswith("https://"), "HTTPS source redirect required")
            raw = response.read(limit + 1)
    require(len(raw) <= limit and hashlib.sha256(raw).hexdigest() == expected, "Source digest differs")
    target.write_bytes(raw)
    return raw


def module_hashes(source):
    return {name: sha(source / name) for name in ("go.mod", "go.sum")}


def go_source_hashes(source):
    return {str(p.relative_to(source)): sha(p) for p in source.rglob("*.go") if not p.name.endswith("_test.go")}


def copy_notices(directory, target, label):
    notices = sorted(p for p in directory.iterdir()
                     if p.name.upper().startswith(("LICENSE", "LICENCE", "NOTICE", "COPYING")) and p.is_file())
    require(notices, "Missing upstream license notices: " + label)
    for notice in notices:
        require(not notice.is_symlink() and notice.stat().st_size <= 1024**2, "Unsafe license notice")
        shutil.copyfile(notice, target / (label.replace("/", "__") + "--" + notice.name))


def build(output, cache, retained, builder, vendor_custody):
    lock_bytes = (HERE / "sources.lock.json").read_bytes()
    lock = json.loads(lock_bytes)
    require(lock["schema_version"] == 1 and lock["platform"] == "linux/arm64"
            and lock["operational_qualification"] is False, "Unsupported build-only lock")
    require(output.is_absolute() and not output.exists() and not output.parent.is_symlink(), "Use a new absolute output directory")
    require(cache.is_absolute() and not cache.is_symlink(), "Use an ordinary absolute cache directory")
    require(sha(HERE / "Builder.Dockerfile") == lock["builder_dockerfile_sha256"], "Builder recipe differs")
    require(sha(HERE / "vendor-runtime-files.json") == lock["vendor_inventory_sha256"], "Vendor inventory differs")
    require(sha(HERE / "containerd-parser-fixtures.patch") == lock["containerd_test_patch_sha256"], "Test fixture patch differs")
    output.mkdir(mode=0o700)
    # Source/notice custody is mandatory before any builder or vendor execution.
    custody = retain_custody(lock, vendor_custody, output)
    cache.mkdir(mode=0o700, exist_ok=True)
    require(shutil.disk_usage(output).free > 24 * 1024**3, "Insufficient local build/restore space")
    if builder is None:
        context = output / "builder"
        context.mkdir()
        shutil.copyfile(HERE / "Builder.Dockerfile", context / "Dockerfile")
        subprocess.run(["docker", "build", "--platform", "linux/arm64", "--iidfile", str(output / "builder.id"), str(context)], check=True)
        builder = (output / "builder.id").read_text().strip()
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", builder), "Immutable builder image ID required")
    identity = json.loads(subprocess.check_output(["docker", "image", "inspect", builder]))[0]
    require(identity["Architecture"] == "arm64" and identity["Os"] == "linux", "ARM64 Linux builder required")
    base = ["docker", "run", "--rm", "--platform", "linux/arm64", "--cpus", "2", "--memory", "3g",
            "--pids-limit", "512", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--user", f"{os.getuid()}:{os.getgid()}"]
    packages = subprocess.check_output([*base, "--network", "none", builder,
                                       "cat", "/usr/local/share/onesa-k3s-builder-packages.txt"], timeout=30)
    require(hashlib.sha256(packages).hexdigest() == lock["builder_packages_sha256"], "Builder package versions differ")
    (output / "builder-packages.txt").write_bytes(packages)
    binaries = output / "binaries"
    binaries.mkdir()
    licenses = output / "licenses"
    licenses.mkdir()
    results = {}
    with (output / "build.log").open("w") as log:
        def command(source, args, *, network=False, writable=False, cgo="1", cflags="", capture=False):
            cmd = [*base, *([] if network else ["--network", "none"]),
                   "-v", str(source) + ":/src" + ("" if writable else ":ro"),
                   "-v", str(cache) + ":/cache", "-v", str(output) + ":/out", "-w", "/src",
                   "-e", "GOCACHE=/cache/build", "-e", "GOMODCACHE=/cache/mod", "-e", "GOPATH=/cache",
                   "-e", "GOMAXPROCS=2", "-e", "GOTOOLCHAIN=local", "-e", "GOTELEMETRY=off",
                   "-e", "GOPROXY=" + ("https://proxy.golang.org" if network else "off"),
                   "-e", "GOSUMDB=" + ("sum.golang.org" if network else "off"),
                   "-e", "GOFLAGS=-mod=readonly", "-e", "CGO_ENABLED=" + cgo,
                   *(["-e", "CGO_CFLAGS=" + cflags] if cflags else []), builder, *args]
            result = subprocess.run(cmd, stdout=subprocess.PIPE if capture else log, stderr=log,
                                    timeout=1800, check=True)
            return result.stdout

        for name in ("runc", "containerd-shim-runc-v2", "k3s"):
            spec = lock["components"][name]
            source = output / name
            source.mkdir()
            raw = fetch(spec["archive_url"], spec["archive_sha256"], output / (name + ".archive"),
                        retained / (name + ".archive") if retained else None)
            unpack(raw, source, spec["archive_type"], spec["archive_prefix"])
            require(module_hashes(source) == spec["original_module_hashes"], "Original module locks differ")
            for filename in ("go.mod", "go.sum"):
                pinned = HERE / "modules" / name / filename
                require(sha(pinned) == spec["module_hashes"][filename], "Patched module locks differ")
                shutil.copyfile(pinned, source / filename)
            if name == "k3s":
                shutil.copytree(source / "manifests", source / "pkg/deploy/embed", dirs_exist_ok=True)
                charts = source / "pkg/static/embed/charts"
                charts.mkdir(exist_ok=True)
                for filename, chart in spec["charts"].items():
                    fetch(chart["url"], chart["sha256"], charts / filename,
                          retained / filename if retained else None)
            production = go_source_hashes(source)
            if name == "containerd-shim-runc-v2":
                subprocess.run(["patch", "--batch", "--forward", "-p1", "-i", str(HERE / "containerd-parser-fixtures.patch")],
                               cwd=source, stdout=log, stderr=log, check=True)
                require(go_source_hashes(source) == production, "Test fixture patch changed production source")
            command(source, ["go", "mod", "download"], network=True)
            command(source, ["go", "mod", "verify"])
            command(source, ["go", "test", "-mod=readonly", "-p", "2", "-count=1", "-timeout", "5m",
                             "-tags", spec["tags"], *spec["tests"]], network=True, writable=True,
                    cflags=spec.get("cgo_cflags", ""))
            require(go_source_hashes(source) == production and module_hashes(source) == spec["module_hashes"],
                    "Tests changed production sources or module locks")
            command(source, ["go", "build", "-mod=readonly", "-trimpath", "-buildvcs=false", "-p", "2",
                             "-tags", spec["tags"], "-ldflags", spec["ldflags"], "-o", "/out/binaries/" + name, spec["package"]],
                    cflags=spec.get("cgo_cflags", ""))
            require(sha(binaries / name) == spec["binary_sha256"], "Rebuilt executable differs from reviewed bytes")
            dirs = command(source, ["go", "list", "-mod=readonly", "-deps", "-tags", spec["tags"],
                                     "-f", "{{with .Module}}{{.Dir}}{{end}}", spec["package"]], capture=True).decode().splitlines()
            for directory in sorted(set(dirs) - {""}):
                if directory == "/src":
                    local, label = source, name
                else:
                    require(directory.startswith("/cache/mod/"), "Unexpected module location")
                    module = relative(directory.removeprefix("/cache/mod/"))
                    local, label = cache / "mod" / module, str(module)
                copy_notices(local, licenses, label)
            results[name] = {"binary_sha256": sha(binaries / name), "upstream_tests": "PASS",
                             "production_source_unchanged": True, "module_locks_unchanged": True}
        (licenses / "Go-LICENSE").write_bytes(command(source, ["cat", "/usr/local/go/LICENSE"], capture=True))
        for package in ("libseccomp-dev", "libselinux1-dev", "libbtrfs-dev", "zlib1g-dev", "libc6-dev"):
            (licenses / (package + "--copyright")).write_bytes(command(source, ["cat", "/usr/share/doc/" + package + "/copyright"], capture=True))
        package_runtime(lock, output, retained, builder, base, command)
    result = {"status": "BUILT_NOT_INSTALL_QUALIFIED", "lock_sha256": hashlib.sha256(lock_bytes).hexdigest(),
              "builder_image": builder, "components": results, "wrapper_sha256": sha(output / "k3s-arm64"),
              "license_files": len(list(licenses.iterdir())), "vendor_custody": custody,
              "installed": False, "published": False,
              "limitations": ["Independent review and exact artifact security assessment required",
                              "Vendor source custody is not legal-completeness or bit-identical rebuild certification",
                              "Embedded registry must remain disabled; DHT has no fixed version",
                              "Vendor add-ons are unqualified and must stay disabled",
                              "No cluster, workload, Portainer or VM recovery acceptance"]}
    (output / "build-result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


def package_runtime(lock, output, retained, builder, base, command):
    vendor = output / "vendor-k3s-arm64"
    fetch(lock["vendor_runtime"]["url"], lock["vendor_runtime"]["sha256"], vendor,
          retained / "vendor-k3s-arm64" if retained else None, limit=128 * 1024**2)
    vendor.chmod(0o755)
    extracted = output / "vendor-extracted"
    extracted.mkdir()
    subprocess.run([*base, "--network", "none", "--read-only", "-v", str(vendor) + ":/vendor:ro",
                    "-v", str(extracted) + ":/data", "-e", "K3S_DATA_DIR=/data", builder,
                    "/vendor", "kubectl", "version", "--client", "-o", "json"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True, timeout=120)
    inventory = json.loads((HERE / "vendor-runtime-files.json").read_text())
    observed_files = {str(p.relative_to(extracted)) for p in extracted.rglob("*")
                      if p.is_file() and not p.is_symlink()}
    require(observed_files == {row["path"] for row in inventory["files"]}, "Vendor regular-file inventory differs")
    for row in inventory["files"]:
        original = extracted / relative(row["path"])
        require(original.is_file() and not original.is_symlink() and original.stat().st_size == row["bytes"]
                and sha(original) == row["sha256"], "Vendor runtime bytes differ")
    payload = output / "payload"
    shutil.copytree(extracted / "data" / lock["vendor_runtime"]["payload"], payload, symlinks=True)
    binroot = payload / "bin"
    for name, spec in lock["components"].items():
        target = binroot / name
        require(target.is_file() and not target.is_symlink(), "Runtime replacement target differs")
        shutil.copyfile(output / "binaries" / name, target)
        target.chmod(0o755)
    expected_links = dict(line.split(" ", 1) for line in (binroot / ".links").read_text().splitlines())
    observed_links = {str(p.relative_to(binroot)): str(p.readlink()) for p in binroot.rglob("*") if p.is_symlink()}
    require(set(expected_links) == set(observed_links), "Vendor link inventory differs")
    aliases = {"aux/" + name for name in ("iptables", "iptables-save", "iptables-restore", "ip6tables", "ip6tables-save", "ip6tables-restore")}
    for name, target in expected_links.items():
        path = binroot / relative(name)
        require(not Path(target).is_absolute() and path.resolve().is_relative_to(payload.resolve()), "Unsafe runtime link")
        if observed_links[name] != target:
            require(name in aliases and target == "iptables-detect.sh"
                    and observed_links[name] in {"xtables-nft-multi", "xtables-legacy-multi"}, "Unexpected vendor link change")
            path.unlink()
            path.symlink_to(target)
    checksums = [sha(p) + "  " + str(p.relative_to(binroot)) for p in sorted(binroot.rglob("*"))
                 if p.is_file() and not p.is_symlink() and not p.name.startswith(".")]
    (binroot / ".sha256sums").write_text("\n".join(checksums) + "\n")
    archive = output / "runtime.tar"
    with tarfile.open(archive, "w", format=tarfile.GNU_FORMAT) as tar:
        for path in sorted(payload.rglob("*"), key=lambda p: str(p.relative_to(payload))):
            info = tar.gettarinfo(str(path), arcname="./" + str(path.relative_to(payload)))
            info.uid = info.gid = info.mtime = 0
            info.uname = info.gname = ""
            if info.isfile():
                with path.open("rb") as stream:
                    tar.addfile(info, stream)
            else:
                tar.addfile(info)
    source = output / "k3s"
    command(source, ["zstd", "--no-progress", "-T1", "-16", "--long=25", "/out/runtime.tar", "-o", "/out/runtime.tar.zst"])
    require(sha(output / "runtime.tar.zst") == lock["candidate_payload_sha256"], "Repacked payload differs")
    embed = source / "pkg/data/embed"
    require(all(p.name in {".empty", ".gitkeep"} and p.is_file() and p.stat().st_size == 0 for p in embed.iterdir()), "Existing embedded runtime refused")
    shutil.copyfile(output / "runtime.tar.zst", embed / (lock["candidate_payload_sha256"] + ".tar.zst"))
    command(source, ["go", "build", "-mod=readonly", "-trimpath", "-buildvcs=false", "-p", "2",
                     "-tags", "urfave_cli_no_docs", "-ldflags", lock["wrapper_ldflags"],
                     "-o", "/out/k3s-arm64", "./cmd/k3s"], cgo="0")
    require(sha(output / "k3s-arm64") == lock["candidate_wrapper_sha256"], "Packaged wrapper differs")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--retained-inputs", type=Path)
    parser.add_argument("--builder-image")
    parser.add_argument("--vendor-custody", type=Path, required=True,
                        help="Private retained inputs matching vendor-custody.lock.json")
    args = parser.parse_args()
    os.umask(0o077)
    build(args.output, args.cache, args.retained_inputs, args.builder_image, args.vendor_custody)


if __name__ == "__main__":
    main()
