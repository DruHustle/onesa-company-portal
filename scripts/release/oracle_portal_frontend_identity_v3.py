"""Public callback configuration for the eight-client Portal issuer."""
from pathlib import Path

import oracle_portal as portal
import oracle_portal_frontend_identity_v2 as seven

PROFILE = "frontend-identity-v3"
ISSUER_PLAN = Path("/etc/onesa/oracle-portal-identity-release-v3.json")
CALLBACK_KEY = seven.CALLBACK_KEY
PRODUCTION = {**seven.PRODUCTION, "factory": "https://factory.onesa.eu"}
CALLBACK_PATHS = {**seven.CALLBACK_PATHS, "factory": "/api/auth/onesa/callback"}
# Exact frontend subtree of the gateway change on 6a758fde.
CANDIDATE_TREE = "e6486553e05ff32d7650b0db1bc1d5351017f65e"
RETAINED_TREES = seven.RETAINED_TREES | {CANDIDATE_TREE}


def verify_callbacks(binding, environment, encoded):
    issuer = portal.read(portal.component_plan_path(binding, ISSUER_PLAN))
    portal.require(issuer.get("qualification_profile") == "portal-shared-identity-v3",
                   "EIGHT_CLIENT_ISSUER_PLAN_REQUIRED")
    seven.verify_registered_urls(issuer, environment, encoded, PRODUCTION, CALLBACK_PATHS,
                                 "EXACT_ISOLATED_EIGHT_CLIENT_ORIGINS_REQUIRED")
