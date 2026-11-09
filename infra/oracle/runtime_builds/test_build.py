"""Adversarial source-archive tests; actual upstream builds are separate."""
import importlib.util
import io
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("runtime_build", Path(__file__).with_name("build.py"))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


def tar_bytes(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, content, kind in entries:
            info = tarfile.TarInfo(name)
            info.mode = 0o755
            info.type = kind
            if kind == tarfile.REGTYPE:
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
            else:
                info.linkname = content.decode()
                archive.addfile(info)
    return output.getvalue()


class LicenseNoticeTests(unittest.TestCase):
    def test_missing_vendor_custody_blocks_before_any_docker_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            inputs = root / "inputs"
            inputs.mkdir()
            with patch.object(build.subprocess, "run") as run, patch.object(build.subprocess, "check_output") as read:
                with self.assertRaises(FileNotFoundError):
                    build.build(root / "output", root / "cache", None, None, inputs)
                run.assert_not_called()
                read.assert_not_called()
            self.assertFalse((root / "output/vendor-custody.tar.gz").exists())

    def test_original_notices_preserved_with_either_spelling(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / "source", root / "notices"
            source.mkdir()
            target.mkdir()
            for name in ("LICENSE", "LICENCE", "NOTICE.txt", "COPYING"):
                content = ("Original upstream " + name + "\n").encode()
                (source / name).write_bytes(content)
            build.copy_notices(source, target, "example/module@v1")
            for notice in source.iterdir():
                self.assertEqual((target / ("example__module@v1--" + notice.name)).read_bytes(), notice.read_bytes())

    def test_missing_and_linked_notices_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / "source", root / "notices"
            source.mkdir()
            target.mkdir()
            with self.assertRaisesRegex(ValueError, "Missing upstream"):
                build.copy_notices(source, target, "module")
            (root / "outside").write_text("outside")
            (source / "LICENCE").symlink_to(root / "outside")
            with self.assertRaisesRegex(ValueError, "Unsafe license"):
                build.copy_notices(source, target, "module")
            self.assertEqual(list(target.iterdir()), [])


class SourceArchiveTests(unittest.TestCase):
    def unpack(self, raw, kind="tar", prefix="source"):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        destination = Path(temporary.name) / "source"
        destination.mkdir()
        build.unpack(raw, destination, kind, prefix)
        return destination

    def test_regular_source_preserves_bytes_and_executable_mode(self):
        path = self.unpack(tar_bytes([("source/bin/check", b"#!/bin/sh\nexit 0\n", tarfile.REGTYPE)]))
        self.assertEqual((path / "bin/check").read_bytes(), b"#!/bin/sh\nexit 0\n")
        self.assertEqual((path / "bin/check").stat().st_mode & 0o777, 0o755)

    def test_tar_links_and_special_files_are_rejected(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE):
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, "links/devices"):
                self.unpack(tar_bytes([("source/escape", b"../../outside", kind)]))

    def test_paths_and_foreign_prefixes_are_rejected(self):
        for name in ("source/../outside", "/outside", "other/file", "source\\outside", "source/./file"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.unpack(tar_bytes([(name, b"private", tarfile.REGTYPE)]))

    def test_duplicate_names_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            self.unpack(tar_bytes([("source/go.mod", b"first", tarfile.REGTYPE),
                                   ("source/go.mod", b"second", tarfile.REGTYPE)]))

    def test_total_expansion_is_bounded(self):
        raw = tar_bytes([("source/one", b"a" * 12, tarfile.REGTYPE),
                         ("source/two", b"b" * 12, tarfile.REGTYPE)])
        with patch.object(build, "MAX_EXTRACTED", 16), self.assertRaisesRegex(ValueError, "bounds"):
            self.unpack(raw)

    def test_go_module_zip_prefix_and_notices(self):
        output = io.BytesIO()
        prefix = "github.com/example/runtime@v1.0.0"
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr(prefix + "/LICENSE", "Retained upstream notice\n")
            archive.writestr(prefix + "/go.mod", "module github.com/example/runtime\n")
        path = self.unpack(output.getvalue(), "zip", prefix)
        self.assertEqual((path / "LICENSE").read_text(), "Retained upstream notice\n")

    def test_zip_symlink_is_rejected(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            info = zipfile.ZipInfo("source/link")
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, "../../outside")
        with self.assertRaisesRegex(ValueError, "links/devices"):
            self.unpack(output.getvalue(), "zip")

    def test_empty_archive_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Empty"):
            self.unpack(tar_bytes([]))


if __name__ == "__main__":
    unittest.main()
