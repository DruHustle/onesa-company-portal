import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { JSONWebKeySet } from 'jose';
import { BillingError, ensure, type CatalogItem, type ProviderScope } from './domain.js';
import type { Actor } from './domain.js';
import type { UsageBinding } from './usage.js';

export type DatabaseRole = 'api' | 'dispatcher' | 'webhook' | 'meter';
export interface UsageAuthorization { actor: Actor; binding: UsageBinding }

export class BillingSecrets {
  #stripe: string;
  #webhook: string;
  #metronome?: string;
  #databases: Readonly<Record<DatabaseRole, string>>;
  constructor(stripe: string, webhook: string, metronome: string | undefined, databases: Record<DatabaseRole, string>) {
    this.#stripe = stripe; this.#webhook = webhook; this.#metronome = metronome;
    this.#databases = Object.freeze({ ...databases });
  }
  get stripe(): string { return this.#stripe; }
  get webhook(): string { return this.#webhook; }
  get metronome(): string | undefined { return this.#metronome; }
  database(role: DatabaseRole): string { return this.#databases[role]; }
  toJSON(): string { return '[REDACTED]'; }
}

export interface BillingConfig {
  scope: ProviderScope;
  host: string;
  port: number;
  allowedOrigins: string[];
  returnBase: string;
  authIssuer: string;
  authAudience: string;
  authJwks: JSONWebKeySet;
  catalog: CatalogItem[];
  catalogFingerprint: string;
  taxEnabled: boolean;
  salesEnabled: boolean;
  invoiceDaysUntilDue: number;
  portalConfigurationId?: string;
  integrationIdentifier: string;
  metronomeProjectId?: string;
  usageAuthorizations: UsageAuthorization[];
  secrets: BillingSecrets;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  ensure(value, `CONFIG_REQUIRED_${name}`, 503);
  return value;
}

function secret(env: NodeJS.ProcessEnv, name: string, optional = false): string | undefined {
  ensure(!(env[name] && env[`${name}_FILE`]), `CONFIG_AMBIGUOUS_${name}`, 503);
  let value = env[name];
  if (env[`${name}_FILE`]) {
    try { value = readFileSync(env[`${name}_FILE`]!, 'utf8').trim(); }
    catch { throw new BillingError(`CONFIG_UNREADABLE_${name}`, 503); }
  }
  if (!optional) ensure(value, `CONFIG_REQUIRED_${name}`, 503);
  return value;
}

function jsonFile(env: NodeJS.ProcessEnv, name: string): unknown {
  try { return JSON.parse(readFileSync(required(env, name), 'utf8')); }
  catch (error) {
    if (error instanceof BillingError) throw error;
    throw new BillingError(`CONFIG_INVALID_${name}`, 503);
  }
}

function origin(value: string, allowLocal: boolean): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new BillingError('CONFIG_INVALID_ORIGIN', 503); }
  ensure(!parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === '/', 'CONFIG_INVALID_ORIGIN', 503);
  ensure(parsed.protocol === 'https:' || (allowLocal && parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)), 'CONFIG_HTTPS_REQUIRED', 503);
  return parsed.origin;
}

export function validateCatalog(input: unknown): CatalogItem[] {
  ensure(Array.isArray(input) && input.length > 0 && input.length <= 100, 'CONFIG_INVALID_CATALOG', 503);
  const skus = new Set<string>();
  return input.map((item: unknown) => {
    ensure(item !== null && typeof item === 'object' && !Array.isArray(item), 'CONFIG_INVALID_CATALOG', 503);
    const value = item as Record<string, unknown>;
    const keys = ['sku', 'title', 'version', 'kind', 'priceId', 'currency', 'unitAmount', 'taxBehavior', 'maxQuantity'];
    ensure(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'CONFIG_INVALID_CATALOG', 503);
    ensure(typeof value.sku === 'string' && /^[a-z][a-z0-9_-]{1,63}$/.test(value.sku) && !skus.has(value.sku), 'CONFIG_INVALID_SKU', 503);
    skus.add(value.sku);
    ensure(typeof value.title === 'string' && value.title.length > 0 && value.title.length <= 150 && !/[\r\n\u0000]/.test(value.title), 'CONFIG_INVALID_TITLE', 503);
    ensure(typeof value.version === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(value.version), 'CONFIG_INVALID_CATALOG_VERSION', 503);
    ensure(value.kind === 'one_off' || value.kind === 'metered', 'CONFIG_INVALID_OFFER_KIND', 503);
    ensure(typeof value.priceId === 'string' && (value.kind === 'metered' ? value.priceId === '' : /^price_[A-Za-z0-9]+$/.test(value.priceId)), 'CONFIG_INVALID_PRICE', 503);
    ensure(typeof value.currency === 'string' && /^[a-z]{3}$/.test(value.currency), 'CONFIG_INVALID_CURRENCY', 503);
    ensure(Number.isSafeInteger(value.unitAmount) && Number(value.unitAmount) > 0 && Number(value.unitAmount) <= 99_999_999, 'CONFIG_INVALID_AMOUNT', 503);
    ensure(value.taxBehavior === 'inclusive' || value.taxBehavior === 'exclusive', 'CONFIG_INVALID_TAX_BEHAVIOR', 503);
    ensure(Number.isSafeInteger(value.maxQuantity) && Number(value.maxQuantity) >= 1 && Number(value.maxQuantity) <= 1000, 'CONFIG_INVALID_QUANTITY', 503);
    return { ...value } as unknown as CatalogItem;
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const mode = env.BILLING_MODE ?? 'test';
  ensure(mode === 'test' || mode === 'live', 'CONFIG_INVALID_MODE', 503);
  ensure(mode !== 'live' || env.BILLING_ALLOW_LIVE === 'true', 'LIVE_MODE_NOT_AUTHORIZED', 503);
  const stripe = secret(env, 'STRIPE_SECRET_KEY')!;
  ensure(new RegExp(`^(?:sk|rk)_${mode}_[A-Za-z0-9]{12,}$`).test(stripe), 'CONFIG_KEY_MODE_MISMATCH', 503);
  const webhook = secret(env, 'STRIPE_WEBHOOK_SECRET')!;
  ensure(/^whsec_[A-Za-z0-9]{12,}$/.test(webhook), 'CONFIG_INVALID_WEBHOOK_SECRET', 503);
  const account = required(env, 'STRIPE_ACCOUNT_ID');
  ensure(/^acct_[A-Za-z0-9]+$/.test(account), 'CONFIG_INVALID_STRIPE_ACCOUNT', 503);
  const configVersion = required(env, 'BILLING_CONFIG_VERSION');
  ensure(/^[A-Za-z0-9._-]{1,64}$/.test(configVersion), 'CONFIG_INVALID_VERSION', 503);
  const catalog = validateCatalog(jsonFile(env, 'BILLING_CATALOG_FILE'));
  const jwks = jsonFile(env, 'BILLING_AUTH_JWKS_FILE') as JSONWebKeySet;
  ensure(jwks && Array.isArray(jwks.keys) && jwks.keys.length > 0 && jwks.keys.length <= 8, 'CONFIG_INVALID_JWKS', 503);
  const privateFields = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];
  ensure(jwks.keys.every(key => key && privateFields.every(field => !Object.hasOwn(key, field))
    && ['RSA', 'EC', 'OKP'].includes(key.kty ?? '') && typeof key.kid === 'string'), 'CONFIG_PUBLIC_JWKS_ONLY', 503);
  const returnBase = origin(required(env, 'BILLING_RETURN_ORIGIN'), mode === 'test');
  const allowedOrigins = (env.BILLING_ALLOWED_ORIGINS ?? returnBase).split(',').map(value => origin(value.trim(), mode === 'test'));
  ensure(allowedOrigins.length <= 8, 'CONFIG_ORIGIN_BOUND', 503);
  const port = Number(env.PORT ?? '8099');
  ensure(Number.isInteger(port) && port > 0 && port <= 65535, 'CONFIG_INVALID_PORT', 503);
  const invoiceDaysUntilDue = Number(required(env, 'BILLING_INVOICE_DAYS_UNTIL_DUE'));
  ensure(Number.isInteger(invoiceDaysUntilDue) && invoiceDaysUntilDue >= 1 && invoiceDaysUntilDue <= 365, 'CONFIG_INVALID_INVOICE_TERMS', 503);
  const integrationIdentifier = required(env, 'BILLING_INTEGRATION_IDENTIFIER');
  ensure(/^onesa_company_[a-z]{8}$/.test(integrationIdentifier), 'CONFIG_INVALID_INTEGRATION_IDENTIFIER', 503);
  const databases = Object.fromEntries((['api', 'dispatcher', 'webhook', 'meter'] as const).map(role => {
    const value = secret(env, `BILLING_${role.toUpperCase()}_DATABASE_URL`)!;
    ensure(/^postgres(?:ql)?:\/\//.test(value), 'CONFIG_INVALID_DATABASE_URL', 503);
    let address: URL;
    try { address = new URL(value); } catch { throw new BillingError('CONFIG_INVALID_DATABASE_URL', 503); }
    ensure(address.hostname && address.username && !address.hash && /^\/[A-Za-z0-9_-]{1,63}$/.test(address.pathname), 'CONFIG_EXPLICIT_DATABASE_REQUIRED', 503);
    ensure([...address.searchParams.keys()].every(key => ['sslmode', 'sslrootcert', 'connect_timeout', 'application_name'].includes(key)),
      'CONFIG_DATABASE_QUERY_FORBIDDEN', 503);
    return [role, value];
  })) as Record<DatabaseRole, string>;
  const targets = Object.values(databases).map(value => {
    const url = new URL(value);
    return JSON.stringify([url.hostname.toLowerCase(), url.port || '5432', url.pathname]);
  });
  ensure(new Set(targets).size === 1, 'CONFIG_DATABASE_TARGET_MISMATCH', 503);
  const usageAuthorizations = env.BILLING_USAGE_BINDINGS_FILE ? jsonFile(env, 'BILLING_USAGE_BINDINGS_FILE') : [];
  ensure(Array.isArray(usageAuthorizations) && usageAuthorizations.length <= 100, 'CONFIG_INVALID_USAGE_BINDINGS', 503);
  for (const entry of usageAuthorizations) {
    ensure(entry && typeof entry === 'object' && Object.keys(entry).length === 2 && entry.actor && entry.binding,
      'CONFIG_INVALID_USAGE_BINDINGS', 503);
    ensure(typeof entry.actor.issuer === 'string' && typeof entry.actor.subject === 'string'
      && entry.actor.issuer === required(env, 'BILLING_AUTH_ISSUER'), 'CONFIG_INVALID_USAGE_BINDINGS', 503);
    ensure(entry.binding.scope?.application === 'company' && entry.binding.scope.stripeAccountId === account
      && entry.binding.scope.mode === mode && entry.binding.scope.configVersion === configVersion,
      'CONFIG_INVALID_USAGE_BINDINGS', 503);
    ensure(entry.binding.metronomeProjectId === env.METRONOME_PROJECT_ID
      && entry.binding.environment === (mode === 'test' ? 'sandbox' : 'production'), 'CONFIG_INVALID_USAGE_BINDINGS', 503);
  }
  const grantKeys = usageAuthorizations.map(entry => `${entry.actor.issuer}\0${entry.actor.subject}\0${entry.binding.meterId}`);
  ensure(new Set(grantKeys).size === grantKeys.length, 'CONFIG_AMBIGUOUS_USAGE_BINDING', 503);
  return {
    scope: { application: 'company', stripeAccountId: account, mode, configVersion },
    host: env.HOST ?? '127.0.0.1', port, allowedOrigins, returnBase,
    authIssuer: required(env, 'BILLING_AUTH_ISSUER'), authAudience: 'onesa-billing', authJwks: jwks,
    catalog, catalogFingerprint: createHash('sha256').update(JSON.stringify(catalog)).digest('hex'),
    taxEnabled: env.BILLING_AUTOMATIC_TAX === 'true', salesEnabled: env.BILLING_SALES_ENABLED === 'true',
    invoiceDaysUntilDue, portalConfigurationId: env.STRIPE_PORTAL_CONFIGURATION_ID,
    integrationIdentifier, metronomeProjectId: env.METRONOME_PROJECT_ID,
    usageAuthorizations: usageAuthorizations as UsageAuthorization[],
    secrets: new BillingSecrets(stripe, webhook, secret(env, 'METRONOME_API_TOKEN', true), databases),
  };
}
