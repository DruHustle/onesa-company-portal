"""Owner-commissioned eight-client issuer release entry point."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from oracle_portal_identity import CHECKS_V3 as CHECKS, PROFILE_V3 as PROFILE, main

if __name__ == "__main__":
    main(expected_profile=PROFILE)
