"""Pin only the reviewed harmless historical Xcode environment bootstrap."""
import hashlib
import importlib.util
import unittest
import sys
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "repository_hygiene.py"
# The root scanner imports "ci.config" from scripts/, unlike test discovery.
sys.path.insert(0, str(SOURCE.parent))
spec = importlib.util.spec_from_file_location("hygiene_historical_bootstrap", SOURCE)
scanner = importlib.util.module_from_spec(spec)
# A stub for the path-based module importer is unnecessary; scripts/ci is on sys.path
spec.loader.exec_module(scanner)

BOOTSTRAP = (
    b"# This `.xcode.env` file is versioned and is used to source the environment\n"
    b"# used when running script phases inside Xcode.\n"
    b"# To customize your local environment, you can create an `.xcode.env.local`\n"
    b"# file that is not versioned.\n"
    b"\n"
    b"# NODE_BINARY variable contains the PATH to the node executable.\n"
    b"#\n"
    b"# Customize the NODE_BINARY variable here.\n"
    b"# For example, to use nvm with brew, add the following line\n"
    b'# . "$(brew --prefix nvm)/nvm.sh" --no-use\n'
    b"export NODE_BINARY=$(command -v node)\n"
)

class HistoricalXcodeBootstrapTests(unittest.TestCase):
    def test_exact_blob_only_in_history(self):
        self.assertEqual(
            hashlib.sha1(b"blob " + str(len(BOOTSTRAP)).encode() + b"\0" + BOOTSTRAP).hexdigest(),
            scanner.HISTORICAL_XCODE_BLOB,
        )
        self.assertTrue(scanner.reviewed_historical_xcode_bootstrap(
            "history:54d01da10a9d",scanner.HISTORICAL_XCODE_PATH,BOOTSTRAP
        ))
        for scope in ("index","worktree",""):
            self.assertFalse(scanner.reviewed_historical_xcode_bootstrap(
                scope,scanner.HISTORICAL_XCODE_PATH,BOOTSTRAP
            ))
        for mode in ("100755","120000","160000"):
            self.assertFalse(scanner.reviewed_historical_xcode_bootstrap(
                "history:54d01da10a9d",scanner.HISTORICAL_XCODE_PATH,BOOTSTRAP,mode
            ))
    def test_modified_content_or_other_path_never_allowed(self):
        variants=(BOOTSTRAP+b"SECRET=synthetic\n",
                  BOOTSTRAP.replace(b"command -v node",b"command -v secret"),
                  BOOTSTRAP.replace(b"NODE_BINARY",b"PRIVATE_API_KEY"))
        for data in variants:
            self.assertFalse(scanner.reviewed_historical_xcode_bootstrap(
                "history:54d01da10a9d",scanner.HISTORICAL_XCODE_PATH,data
            ))
        for path in ("onesa-mobile/onesa-mobile-frontend/mobile/ios/.xcode.env.local",
                     "onesa-drone/frontend/mobile/ios/.xcode.env",
                     ".xcode.env"):
            self.assertFalse(scanner.reviewed_historical_xcode_bootstrap(
                "history:54d01da10a9d",path,BOOTSTRAP
            ))

if __name__=="__main__":
    unittest.main()
