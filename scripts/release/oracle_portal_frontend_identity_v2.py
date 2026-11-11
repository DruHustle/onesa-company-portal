"""Public callback configuration and exact frontend Git trees for seven clients."""
import json
import re
from pathlib import Path

import oracle_portal as portal

PROFILE = "frontend-identity-v2"
CALLBACK_KEY = "ONESA_IDENTITY_CALLBACKS_JSON"
ISSUER_PLAN = Path("/etc/onesa/oracle-portal-identity-release-v2.json")
# Git subtree IDs include every frontend path, file mode and byte. The full
# provider-retained baseline and candidate archives are authenticated separately.
RETAINED_TREES = {
    "e29f3ca0bd277d550e1249a6124475f35a57f933",  # Served 7f72381.
    "98d7444afdc7b9eb1e57890895f35cabb44ff3f9",  # Reviewed main d3c4448.
    "71201e7dcb2ab3e179e9650fd771b9cb9ed5ef86",  # Same source, fresh configuration.
}
CANDIDATE_TREE = "71201e7dcb2ab3e179e9650fd771b9cb9ed5ef86"  # Reviewed staging b92e22f.
PRODUCTION = {
    "portal": "https://portal.onesa.eu",
    "ai": "https://platform.onesa.eu",
    "drone": "https://drone.onesa.eu",
    "robot": "https://robot.onesa.eu",
    "farmer": "https://farmer.onesa.eu",
    "logistics": "https://logistics.onesa.eu",
    "pasofi": "https://pasofi.mobile.onesa.eu",
    "mobile": "https://mobile.onesa.eu",
}
CALLBACK_PATHS = {
    "ai": "/api/v1/auth/onesa/callback",
    "drone": "/api/v1/auth/identity/callback",
    "robot": "/api/v1/auth/identity/callback",
    "farmer": "/auth/onesa/callback",
    "logistics": "/api/auth/onesa/callback",
    "pasofi": "/onesa-callback.html",
    "mobile": "/api/v1/auth/onesa/callback",
}


def verify_callbacks(binding, environment, encoded):
    # This root-owned release plan contains public origins and protected file
    # references. Read only the origins. The frontend never opens a client file.
    path = portal.component_plan_path(binding, ISSUER_PLAN)
    issuer = portal.read(path)
    portal.require(issuer.get("qualification_profile") == "portal-shared-identity-v2",
                   "SEVEN_CLIENT_ISSUER_PLAN_REQUIRED")
    selected = issuer["environments"]
    origins = selected[environment]["origins"]
    staging = selected["staging"]["origins"]
    portal.require(selected["production"]["origins"] == PRODUCTION
                   and isinstance(staging, dict) and staging.keys() == PRODUCTION.keys()
                   and all(isinstance(value, str) and len(value) <= 255
                           and re.fullmatch(r"https://[a-z0-9-]+(?:\.[a-z0-9-]+)+", value)
                           for value in staging.values())
                   and len(set(staging.values())) == len(PRODUCTION)
                   and set(staging.values()).isdisjoint(PRODUCTION.values()),
                   "EXACT_ISOLATED_SEVEN_CLIENT_ORIGINS_REQUIRED")
    try:
        urls = json.loads(encoded)
    except (TypeError, ValueError):
        urls = None
    expected = {origins[product] + path for product, path in CALLBACK_PATHS.items()}
    portal.require(isinstance(urls, list) and len(urls) == len(expected)
                   and all(isinstance(url, str) for url in urls) and set(urls) == expected,
                   "FRONTEND_CALLBACKS_DIFFER_FROM_REGISTERED_CLIENT_ORIGINS")
