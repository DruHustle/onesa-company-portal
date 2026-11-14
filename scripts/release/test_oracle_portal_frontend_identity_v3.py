"""Eight public callbacks must match the independently installed v3 issuer."""
import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

import oracle_install as installer
import oracle_portal as portal
import oracle_portal_frontend as frontend
import oracle_portal_frontend_identity_v2 as seven
import oracle_portal_frontend_identity_v3 as eight
import oracle_portal_identity as issuer
import test_oracle_portal_frontend as provider_fixture


class EightClientFrontendTests(unittest.TestCase):
    def setUp(self):
        self.binding = {"repository": "DruHustle/onesa-company-portal", "component": "frontend"}
        self.staging = {key: "https://" + key + ".stage.example" for key in eight.PRODUCTION}
        self.issuer = {"qualification_profile": issuer.PROFILE_V3, "environments": {
            "staging": {"origins": self.staging}, "production": {"origins": eight.PRODUCTION}}}
        self.provider = provider_fixture.ProviderConfigurationTests()
        self.provider.setUp()
        self.plan = self.provider.plan
        self.plan.update(qualification_profile=eight.PROFILE, binding=self.binding)
        for env, entry in self.issuer['environments'].items():
            self.plan['server_public_configuration'][env]['ONESA_IDENTITY_ENABLED'] = 'true'
            callbacks = [entry['origins'][product] + path for product, path in eight.CALLBACK_PATHS.items()]
            self.plan['server_public_configuration'][env][eight.CALLBACK_KEY] = json.dumps(callbacks)
            for key in (eight.CALLBACK_KEY, 'ONESA_IDENTITY_ENABLED'):
                identifier = 'fixture_' + env + '_' + key.lower()
                self.plan['server_public_variable_ids'][env][key] = identifier
                self.provider.variables[identifier] = {
                    'id': identifier, 'key': key, 'value': self.plan['server_public_configuration'][env][key],
                    'type': 'plain', 'target': ['preview' if env == 'staging' else 'production'],
                    'gitBranch': 'staging' if env == 'staging' else None, 'updatedAt': 1,
                }

    def check_environment(self, environment):
        with patch.object(portal, 'read', return_value=self.issuer) as read:
            result = portal.public_server_configuration(self.plan, environment)
        read.assert_called_once_with(issuer.PLAN_V3)
        return result

    def test_environments_match_the_issuer_and_only_eight_exact_urls(self):
        self.assertEqual(eight.PRODUCTION, issuer.ORIGINS_V3)
        self.assertEqual(eight.CALLBACK_PATHS, issuer.CALLBACKS_V3)
        for env in self.issuer['environments']:
            self.check_environment(env)
        values = self.plan['server_public_configuration']['staging']
        callbacks = json.loads(values[eight.CALLBACK_KEY])
        for bad in [callbacks[:-1], callbacks + [callbacks[0]], callbacks[:-1] + [callbacks[-1] + '/wrong']]:
            values[eight.CALLBACK_KEY] = json.dumps(bad)
            with self.assertRaisesRegex(portal.Refused, 'FRONTEND_CALLBACKS_DIFFER'):
                self.check_environment('staging')
        values[eight.CALLBACK_KEY] = json.dumps(callbacks)
        self.staging['factory'] = eight.PRODUCTION['factory']
        with self.assertRaisesRegex(portal.Refused, 'EXACT_ISOLATED_EIGHT_CLIENT_ORIGINS'):
            self.check_environment('staging')

    def test_shared_entry_requires_the_enabled_server_flag_only_on_eight_client_profiles(self):
        key = 'ONESA_IDENTITY_ENABLED'
        self.assertNotIn(key, portal.public_server_keys({'qualification_profile': seven.PROFILE}))
        for env in self.issuer['environments']:
            values = self.plan['server_public_configuration'][env]
            values[key] = 'false'
            with self.assertRaisesRegex(portal.Refused, 'SHARED_FRONTEND_IDENTITY_REQUIRED'):
                self.check_environment(env)
            del values[key]
            with self.assertRaisesRegex(portal.Refused, 'PUBLIC_SERVER_CONFIGURATION_SHAPE'):
                self.check_environment(env)

    def test_provider_reads_the_enabled_flag_from_each_exact_target(self):
        def read(path):
            return self.issuer if path == eight.ISSUER_PLAN else self.provider.cfg

        def protect():
            self.provider.seal()
            with (patch.object(portal, 'read', side_effect=read),
                  patch.object(portal, 'runtime_values', return_value={'PROXY_SHARED_KEY': 's' * 48}),
                  patch.object(frontend, 'provider', side_effect=self.provider.provider)):
                return frontend.protection(self.plan)

        protect()
        key = 'ONESA_IDENTITY_ENABLED'
        for env in self.issuer['environments']:
            identifier = self.plan['server_public_variable_ids'][env][key]
            self.assertTrue(any(path.endswith('/' + identifier) for path in self.provider.calls))
        row = self.provider.variables[self.plan['server_public_variable_ids']['production'][key]]
        row['value'] = 'false'
        with self.assertRaisesRegex(portal.Refused, 'EXISTING_SERVER_CONFIGURATION_CHANGED'):
            protect()
        row['value'] = 'true'
        row['target'].append('preview')
        with self.assertRaisesRegex(portal.Refused, 'ISOLATED_FRONTEND_'):
            protect()

    def test_legacy_authority_and_incomplete_tool_closure_are_refused(self):
        self.issuer['qualification_profile'] = issuer.PROFILE_V2
        with self.assertRaisesRegex(portal.Refused, 'EIGHT_CLIENT_ISSUER_PLAN_REQUIRED'):
            self.check_environment('production')
        self.assertEqual(portal.callback_profile(seven.PROFILE), seven)
        self.assertEqual(portal.callback_profile(eight.PROFILE), eight)
        self.assertTrue(installer.IDENTITY_FRONTEND_V2_ALLOWED.keys() < installer.IDENTITY_FRONTEND_V3_ALLOWED.keys())
        root = Path(__file__).resolve().parents[2]
        paths = subprocess.check_output(['git', '-C', str(root), 'ls-files'], text=True).splitlines()
        files = dict.fromkeys(paths, 'a' * 64)
        v3_source = 'scripts/release/oracle_portal_frontend_identity_v3.py'
        files[v3_source] = 'b' * 64
        self.assertIn(v3_source, portal.probe_source_files(files, eight.PROFILE))
        del files[v3_source]
        self.assertNotIn(v3_source, portal.probe_source_files(files, seven.PROFILE))
        with self.assertRaisesRegex(portal.Refused, 'COMPLETE_COMMISSIONED_PROBE_SOURCE_REQUIRED'):
            portal.probe_source_files(files, eight.PROFILE)
