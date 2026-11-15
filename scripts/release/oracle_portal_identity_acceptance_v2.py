"""Owner-commissioned seven-client release entry point."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from oracle_portal_identity_acceptance import CHECKS_V2 as CHECKS, PROFILE_V2 as PROFILE, main

if __name__ == "__main__":
    main(expected_profile=PROFILE)
