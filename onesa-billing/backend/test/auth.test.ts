import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createAuthenticator } from '../src/auth.js';

test('signed actor is bound to issuer/audience, and token role claims do not create memberships', async () => {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA');
  const publicJwk = { ...await exportJWK(publicKey), kid: 'test-key' };
  const verify = createAuthenticator({ issuer: 'https://issuer.example.invalid', audience: 'onesa-billing', jwks: { keys: [publicJwk] } });
  const token = await new SignJWT({ scope: 'billing:account', role: 'owner', account_id: 'another-tenant' }).setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' }).setIssuer('https://issuer.example.invalid').setSubject('subject-1').setAudience('onesa-billing').setIssuedAt().setExpirationTime('5m').setJti('test-token-identity').sign(privateKey);
  const result = await verify(`Bearer ${token}`);
  assert.deepEqual(result.actor, { issuer: 'https://issuer.example.invalid', subject: 'subject-1' });
  assert.equal('role' in result, false);
  assert.equal('account_id' in result, false);
  for (const [issuer, audience] of [['https://other.example.invalid', 'onesa-billing'], ['https://issuer.example.invalid', 'another-product']]) {
    const wrong = await new SignJWT({ scope: 'billing:account' }).setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' }).setIssuer(issuer).setSubject('subject-1').setAudience(audience).setIssuedAt().setExpirationTime('5m').setJti('test-token-identity').sign(privateKey);
    await assert.rejects(verify(`Bearer ${wrong}`), /AUTHENTICATION_INVALID/);
  }
});

test('expired, overlong, unsigned, and unknown-scope assertions are rejected', async () => {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA');
  const jwk = { ...await exportJWK(publicKey), kid: 'test-key' };
  const verify = createAuthenticator({ issuer: 'test', audience: 'onesa-billing', jwks: { keys: [jwk] } });
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [{ iat: now - 100, exp: now - 20, scope: 'billing:account' }, { iat: now, exp: now + 3600, scope: 'billing:account' }, { iat: now, exp: now + 60, scope: 'admin:*' }]) {
    const token = await new SignJWT(claims).setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' }).setIssuer('test').setSubject('s').setAudience('onesa-billing').setJti('test-token-identity').sign(privateKey);
    await assert.rejects(verify(`Bearer ${token}`), /AUTHENTICATION_INVALID/);
  }
  await assert.rejects(verify(undefined), /AUTHENTICATION_REQUIRED/);
  await assert.rejects(verify('Bearer ' + 'x'.repeat(9000)), /AUTHENTICATION_REQUIRED/);
  await assert.rejects(verify('Bearer eyJhbGciOiJub25lIn0.e30.'), /AUTHENTICATION_INVALID/);
});
