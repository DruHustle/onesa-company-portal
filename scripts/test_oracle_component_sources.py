"""Reject dangerous source archives before a local component build can escape its root."""

import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest


TOOL = Path(__file__).resolve().parents[1] / "infra/oracle/component_builds/build.py"
spec = importlib.util.spec_from_file_location("onesa_component_build", TOOL)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def archive(entries, link_names=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as source:
        root = tarfile.TarInfo("upstream")
        root.type = tarfile.DIRTYPE
        source.addfile(root)
        for name, kind, content in entries:
            member = tarfile.TarInfo(name)
            member.type = kind
            if kind == tarfile.REGTYPE:
                member.size = len(content)
                source.addfile(member, io.BytesIO(content))
            else:
                member.linkname = (link_names or {}).get(name, "../../outside")
                source.addfile(member)
    return output.getvalue()


class SourceArchiveTests(unittest.TestCase):
    def test_reviewed_document_alias_is_copied_without_creating_a_symlink(self):
        entries = [("upstream/.github/SECURITY.md", tarfile.REGTYPE, b"original policy"),
                   ("upstream/SECURITY.md", tarfile.SYMTYPE, b"")]
        raw = archive(entries, {"upstream/SECURITY.md": ".github/SECURITY.md"})
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            builder.unpack(raw, target, {"SECURITY.md": ".github/SECURITY.md"})
            self.assertFalse((target / "SECURITY.md").is_symlink())
            self.assertEqual((target / "SECURITY.md").read_bytes(), b"original policy")
            self.assertEqual((target / ".github/SECURITY.md").read_bytes(), b"original policy")

    def test_missing_changed_or_escaping_document_alias_is_refused(self):
        entries = [("upstream/.github/SECURITY.md", tarfile.REGTYPE, b"policy"),
                   ("upstream/SECURITY.md", tarfile.SYMTYPE, b"")]
        for actual, reviewed in [(".github/SECURITY.md", {}),
                                 (".github/SECURITY.md", {"SECURITY.md": ".github/OTHER.md"}),
                                 ("../../outside", {"SECURITY.md": "../../outside"}),
                                 ("/outside", {"SECURITY.md": "/outside"}),
                                 ("SECURITY.md", {"SECURITY.md": "SECURITY.md"})]:
            with self.subTest(actual=actual, reviewed=reviewed), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(ValueError):
                    builder.unpack(archive(entries, {"upstream/SECURITY.md": actual}), Path(directory), reviewed)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                builder.unpack(archive(entries[:1]), Path(directory), {"SECURITY.md": ".github/SECURITY.md"})

    def test_notice_collection_keeps_lowercase_and_mixed_case_upstream_licenses(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            names = {"license.md", "LICENSE", "Notice.txt", "Copying", "README.md"}
            for name in names:
                (source / name).write_text("original upstream bytes: " + name)
            notices = builder.license_notices(source)
            self.assertEqual({path.name for path in notices}, names - {"README.md"})
            for path in notices:
                self.assertEqual(path.read_text(), "original upstream bytes: " + path.name)

    def test_regular_files_keep_exact_contents_and_stay_inside_build_root(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "source"
            target.mkdir()
            builder.unpack(archive([("upstream/pkg/main.go", tarfile.REGTYPE, b"package main\n")]), target)
            self.assertEqual((target / "pkg/main.go").read_bytes(), b"package main\n")
            self.assertEqual((target / "pkg/main.go").stat().st_mode & 0o777, 0o644)

    def test_parent_absolute_foreign_root_links_devices_and_duplicate_paths_are_rejected(self):
        cases = [
            [("upstream/../../outside", tarfile.REGTYPE, b"do not write")],
            [("/outside", tarfile.REGTYPE, b"do not write")],
            [("other/outside", tarfile.REGTYPE, b"do not write")],
            [("upstream/link", tarfile.SYMTYPE, b"")],
            [("upstream/link", tarfile.LNKTYPE, b"")],
            [("upstream/device", tarfile.CHRTYPE, b"")],
            [("upstream/file", tarfile.REGTYPE, b"one"), ("upstream/file", tarfile.REGTYPE, b"two")],
        ]
        for entries in cases:
            with self.subTest(entries=entries), tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / "source"
                target.mkdir()
                with self.assertRaises(ValueError):
                    builder.unpack(archive(entries), target)
                self.assertFalse((Path(directory) / "outside").exists())

    def test_existing_output_is_never_reused_or_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            sentinel = target / "keep"
            sentinel.write_text("existing work")
            with self.assertRaises(ValueError):
                builder.build("metrics-server", target)
            self.assertEqual(sentinel.read_text(), "existing work")

    def test_corrupt_retained_archive_stops_before_any_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            retained = root / "upstream.tar.gz"
            retained.write_bytes(b"not the pinned upstream source")
            with self.assertRaisesRegex(ValueError, "Exact upstream source archive"):
                builder.build("metrics-server", root / "output", retained)
            self.assertFalse((root / "output/source").exists())


if __name__ == "__main__":
    unittest.main()
