#!/usr/bin/env python3
"""Build dependency-patched ARM64 components locally; never install or publish.

The source archive, original and patched module locks, builder, certificate source
and expected binary bytes are fixed by the adjacent reviewed lock. Tests run in an
unprivileged container without host sockets or credentials. Runtime validation and
cluster qualification remain separate, mandatory operations.
"""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request


LOCK = Path(__file__).with_name("sources.lock.json")
MAX_ARCHIVE = 32 * 1024 * 1024
MAX_EXTRACTED = 512 * 1024 * 1024


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def unpack(raw, destination, document_symlinks=None):
    """Copy only regular content; reviewed document aliases never become links."""
    aliases = document_symlinks or {}
    observed_aliases = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        members = archive.getmembers()
        if not members or sum(m.size for m in members) > MAX_EXTRACTED:
            raise ValueError("Source archive exceeds bounds")
        prefix = Path(members[0].name).parts[0]
        seen = set()
        for member in members:
            path = Path(member.name)
            if (path.is_absolute() or ".." in path.parts or not path.parts
                    or path.parts[0] != prefix):
                raise ValueError("Unsafe source archive member")
            if len(path.parts) == 1:
                if not member.isdir():
                    raise ValueError("Source archive root must be a directory")
                continue
            relative = Path(*path.parts[1:])
            if relative in seen:
                raise ValueError("Duplicate source archive member")
            seen.add(relative)
            target = destination / relative
            if member.issym():
                link = Path(member.linkname)
                if (aliases.get(relative.as_posix()) != member.linkname
                        or link.is_absolute() or ".." in link.parts or not link.parts):
                    raise ValueError("Unreviewed source archive link")
                original = archive.getmember(str(Path(prefix) / relative.parent / link))
                if not original.isfile():
                    raise ValueError("Document alias must refer directly to a regular file")
                observed_aliases[relative.as_posix()] = member.linkname
                member = original
            if not (member.isfile() or member.isdir()):
                raise ValueError("Unsafe source archive member")
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                if source is None:
                    raise ValueError("Unreadable source archive member")
                with target.open("xb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
        if observed_aliases != aliases:
            raise ValueError("Reviewed document aliases differ from source archive")


def module_hashes(source):
    return {name: sha((source / name).read_bytes()) for name in ("go.mod", "go.sum")}


def license_notices(source):
    """Preserve upstream notice names regardless of filename capitalization."""
    return sorted(path for path in source.iterdir()
                  if path.name.upper().startswith(("LICENSE", "NOTICE", "COPYING"))
                  and path.is_file())


def build(component, output, retained_archive=None, cache=None):
    lock_bytes = LOCK.read_bytes()
    lock = json.loads(lock_bytes)
    if lock["schema_version"] != 1 or lock["platform"] != "linux/arm64":
        raise ValueError("Unsupported component build lock")
    spec = lock["components"][component]
    if not output.is_absolute() or output.exists() or output.parent.is_symlink():
        raise ValueError("Use a new absolute build directory")
    output.mkdir(mode=0o700)
    cache = cache or output / "cache"
    if not cache.is_absolute() or cache.is_symlink():
        raise ValueError("Use an absolute ordinary module-cache directory")
    cache.mkdir(mode=0o700, exist_ok=True)
    if retained_archive:
        if not retained_archive.is_file() or retained_archive.is_symlink():
            raise ValueError("Retained source archive must be an ordinary file")
        with retained_archive.open("rb") as source:
            raw = source.read(MAX_ARCHIVE + 1)
    else:
        request = urllib.request.Request(spec["archive_url"], headers={"User-Agent": "Onesa-component-build"})
        with urllib.request.urlopen(request, timeout=45) as response:
            raw = response.read(MAX_ARCHIVE + 1)
    if len(raw) > MAX_ARCHIVE or sha(raw) != spec["archive_sha256"]:
        raise ValueError("Exact upstream source archive required")
    (output / "source.tar.gz").write_bytes(raw)
    source = output / "source"
    source.mkdir()
    unpack(raw, source, spec.get("document_symlinks"))
    if module_hashes(source) != spec["original_module_hashes"]:
        raise ValueError("Upstream module locks differ from reviewed source")
    identity = json.loads(subprocess.check_output(["docker", "image", "inspect", lock["builder_image"]]))[0]
    if identity["Architecture"] != "arm64" or identity["Os"] != "linux":
        raise ValueError("Retain the pinned ARM64 Go builder first")
    common = ["docker", "run", "--rm", "--platform", "linux/arm64", "--cpus", "2", "--memory", "3g",
              "--pids-limit", "512", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
              "--user", f"{os.getuid()}:{os.getgid()}", "-v", str(source) + ":/src",
              "-v", str(cache) + ":/cache", "-w", "/src", "-e", "GOCACHE=/cache/build",
              "-e", "GOMODCACHE=/cache/mod", "-e", "GOPATH=/cache", "-e", "GOMAXPROCS=2",
              "-e", "GOFLAGS=-mod=mod", "-e", "GOTOOLCHAIN=local",
              "-e", "GOPROXY=https://proxy.golang.org", "-e", "GOSUMDB=sum.golang.org"]
    with (output / "build.log").open("w") as log:
        def go(arguments, network=True):
            command = [*common, *([] if network else ["--network", "none"]), lock["builder_image"], *arguments]
            log.write(json.dumps(arguments) + "\n")
            log.flush()
            subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=1200)

        go(["go", "get", *spec["dependencies"]])
        go(["go", "mod", "tidy"])
        go(["go", "mod", "verify"], network=False)
        if module_hashes(source) != spec["module_hashes"]:
            raise ValueError("Resolved dependency graph differs from reviewed locks")
        go(["go", "test", "-short", "-race", "-p", "2", "-timeout", "5m", *spec["tests"]])
        go(["env", "CGO_ENABLED=0", "GOOS=linux", "GOARCH=arm64", "go", "build", "-mod=readonly",
            "-trimpath", "-buildvcs=false", *(["-tags=" + ",".join(spec["build_tags"])] if spec.get("build_tags") else []),
            "-ldflags", spec["link_flags"], "-o", "/src/onesa-build/" + component,
            spec["package"]], network=False)
    binary = source / "onesa-build" / component
    if sha(binary.read_bytes()) != spec["binary_sha256"]:
        raise ValueError("Rebuilt binary differs from reviewed bytes")
    # Preserve original notices and all linked modules' notices in the runtime.
    command = [*common, "--network", "none", lock["builder_image"], "go", "list", "-mod=readonly",
               "-deps", "-f", "{{with .Module}}{{.Dir}}{{end}}", spec["package"]]
    directories = set(subprocess.check_output(command, text=True, timeout=120).splitlines()) - {""}
    context = output / "image"
    context.mkdir()
    shutil.copy2(binary, context / component)
    notices = context / "licenses"
    notices.mkdir()
    notices.chmod(0o755)
    missing = []
    for directory in sorted(directories):
        if directory == "/src":
            local, label = source, component
        elif directory.startswith("/cache/mod/") and ".." not in Path(directory).parts:
            relative = directory.removeprefix("/cache/mod/")
            local, label = cache / "mod" / relative, relative.replace("/", "__")
        else:
            raise ValueError("Unexpected linked module path")
        files = license_notices(local)
        if not files:
            missing.append(label)
        for notice in files:
            if notice.is_symlink() or notice.stat().st_size > 1024 * 1024:
                raise ValueError("Unexpected license notice")
            copied = notices / (label + "--" + notice.name)
            shutil.copyfile(notice, copied)
            copied.chmod(0o644)
    if missing:
        raise ValueError("Review missing license notices: " + ", ".join(missing))
    license_data = subprocess.check_output([*common, "--network", "none", lock["builder_image"], "cat", "/usr/local/go/LICENSE"], timeout=30)
    (notices / "Go-LICENSE").write_bytes(license_data)
    (notices / "Go-LICENSE").chmod(0o644)
    dockerfile = f'''FROM {lock["certificate_image"]} AS certificates
FROM scratch
COPY --from=certificates /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY {component} /{component}
COPY licenses /licenses
USER 65534:65534
LABEL org.opencontainers.image.source="https://github.com/{spec["repository"]}"
LABEL org.opencontainers.image.revision="{spec["commit"]}"
LABEL org.opencontainers.image.version="{spec["version"]}"
LABEL eu.onesa.dependency-patched="true"
ENTRYPOINT ["/{component}"]
'''
    (context / "Dockerfile").write_text(dockerfile)
    with (output / "image-build.log").open("w") as log:
        subprocess.run(["docker", "build", "--platform", "linux/arm64", "--network", "none",
                        "--iidfile", str(output / "image.id"), str(context)], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=300)
    image = (output / "image.id").read_text().strip()
    runtime = ["docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
               "--security-opt", "no-new-privileges", "--cpus", "1", "--memory", "256m", image]
    version = subprocess.check_output([*runtime, spec.get("version_argument", "--version")], text=True, timeout=30).strip()
    if spec.get("runtime_version_marker", spec["version"]) not in version:
        raise ValueError("Runtime version differs from reviewed build")
    subprocess.run([*runtime, spec.get("help_argument", "--help")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=30)
    result = {"component": component, "version": version, "source_commit": spec["commit"], "lock_sha256": sha(lock_bytes),
              "binary_sha256": sha(binary.read_bytes()), "image_id": image, "upstream_race_tests": "PASS",
              "runtime_version_help": "PASS", "license_files": len(list(notices.iterdir())),
              "installed": False, "published": False, "cluster_acceptance": "NOT_PERFORMED"}
    (output / "build-result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("component", choices=("local-path-provisioner", "metrics-server", "coredns"))
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source-archive", type=Path)
    parser.add_argument("--cache", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    build(args.component, args.output, args.source_archive, args.cache)


if __name__ == "__main__":
    main()
