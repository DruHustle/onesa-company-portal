import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { BillingError, ensure, type Actor } from './domain.js';

export interface AuthConfig { issuer: string; audience: string; jwks: JSONWebKeySet }
export interface AuthenticatedActor { actor: Actor; scopes: readonly string[]; expiresAt: string }

/** Only an explicitly provisioned issuer is trusted. Token roles never become account memberships. */
export function createAuthenticator(config: AuthConfig) {
  const keys = createLocalJWKSet(config.jwks);
  return async (authorization: string | undefined): Promise<AuthenticatedActor> => {
    ensure(authorization && /^Bearer [A-Za-z0-9_.-]{20,8192}$/.test(authorization), 'AUTHENTICATION_REQUIRED', 401);
    try {
      const { payload } = await jwtVerify(authorization.slice(7), keys, {
        issuer: config.issuer, audience: config.audience,
        algorithms: ['EdDSA', 'ES256', 'RS256'], maxTokenAge: '15m', clockTolerance: 5,
        requiredClaims: ['sub', 'iss', 'aud', 'iat', 'exp', 'jti'],
      });
      ensure(typeof payload.sub === 'string' && payload.sub.length > 0 && payload.sub.length <= 200, 'AUTHENTICATION_INVALID', 401);
      ensure(typeof payload.iat === 'number' && typeof payload.exp === 'number' && payload.exp > payload.iat && payload.exp - payload.iat <= 900, 'AUTHENTICATION_INVALID', 401);
      ensure(typeof payload.jti === 'string' && payload.jti.length >= 8 && payload.jti.length <= 200, 'AUTHENTICATION_INVALID', 401);
      ensure(typeof payload.scope === 'string' && payload.scope.length <= 512, 'AUTHENTICATION_INVALID', 401);
      const scopes = payload.scope.split(' ').filter(Boolean);
      ensure(scopes.length > 0 && scopes.every(scope => ['billing:account', 'billing:usage'].includes(scope)), 'AUTHENTICATION_INVALID', 401);
      return { actor: { issuer: config.issuer, subject: payload.sub }, scopes, expiresAt: new Date(payload.exp * 1000).toISOString() };
    } catch { throw new BillingError('AUTHENTICATION_INVALID', 401); }
  };
}
