import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import { BillingError, ensure, type CatalogLine, type CustomerBinding, type ProviderOperation, type ProviderScope, type VerifiedWebhook } from './domain.js';

export const STRIPE_API_VERSION = '2026-10-28.endive' as const;
export const STRIPE_OPERATION_REPLAY_MS = 23 * 60 * 60 * 1000;
const MAX_LINES = 20;
const MAX_WEBHOOK_BYTES = 256 * 1024;
const ids = {
  account: /^acct_[A-Za-z0-9]+$/,
  customer: /^cus_[A-Za-z0-9]+$/,
  price: /^price_[A-Za-z0-9]+$/,
  invoice: /^in_[A-Za-z0-9]+$/,
  invoiceitem: /^ii_[A-Za-z0-9]+$/,
  'checkout.session': /^cs_(?:test_|live_)?[A-Za-z0-9]+$/,
  credit_note: /^cn_[A-Za-z0-9]+$/,
  charge: /^ch_[A-Za-z0-9]+$/,
  event: /^evt_[A-Za-z0-9_]+$/,
} as const;
const opaque = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const fingerprint = /^[a-f0-9]{64}$/;
type Row = Record<string, unknown>;
type ObjectKind = VerifiedWebhook['objectType'];
const eventObjects: Readonly<Record<string, ObjectKind>> = Object.freeze({
  'checkout.session.completed': 'checkout.session',
  'checkout.session.async_payment_succeeded': 'checkout.session',
  'checkout.session.async_payment_failed': 'checkout.session',
  'checkout.session.expired': 'checkout.session',
  'invoice.created': 'invoice',
  'invoice.updated': 'invoice',
  'invoice.finalized': 'invoice',
  'invoice.finalization_failed': 'invoice',
  'invoice.paid': 'invoice',
  'invoice.payment_succeeded': 'invoice',
  'invoice.payment_failed': 'invoice',
  'invoice.payment_action_required': 'invoice',
  'invoice.voided': 'invoice',
  'invoice.marked_uncollectible': 'invoice',
  'customer.updated': 'customer',
  'customer.created': 'customer',
  'credit_note.created': 'credit_note',
  'credit_note.updated': 'credit_note',
  'credit_note.voided': 'credit_note',
  'charge.refunded': 'charge',
});

export interface StripeProviderConfig {
  scope: ProviderScope;
  secretKey: string;
  webhookSecret: string;
  publicOrigin: string;
  automaticTaxEnabled: boolean;
  integrationIdentifier: string;
  portalConfigurationId?: string;
  invoiceDaysUntilDue: number;
  /** Server-owned invoice mapping; never populated from a caller body or an unverified webhook. */
  resolveExternalInvoiceOwner?: (invoiceId: string, customerId: string) => Promise<ExternalInvoiceOwner | null>;
  /** A separate deployment qualification; a live key never enables this implicitly. */
  liveQualified?: boolean;
  now?: () => Date;
}
export interface ExternalInvoiceOwner {
  source: 'metronome';
  invoiceId: string;
  customerId: string;
  accountId: string;
  scope: ProviderScope;
  integrationIdentifier: string;
}
export interface CustomerProfile { name?: string; email?: string }
export interface AccountProjection {
  stripeAccountId: string;
  mode: ProviderScope['mode'];
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
}
export interface CustomerProjection extends CustomerBinding, ObjectOwner {
  taxLocationStatus: 'supported' | 'not_collecting' | 'unrecognized_location' | 'failed' | 'unknown';
}
export interface ObjectOwner {
  accountId: string;
  commercialIntentId: string | null;
  operationId: string | null;
  fingerprint: string | null;
  origin: 'manual' | 'external';
}
export interface PriceLineProjection {
  priceId: string;
  quantity: number;
  currency: string;
  unitAmount: number;
  taxBehavior: 'inclusive' | 'exclusive';
  amountSubtotal: number;
  amountTotal: number;
  amountTax: number;
  amountDiscount: number;
}
export interface InvoiceLineProjection {
  priceId: string | null;
  quantity: number | null;
  currency: string;
  amount: number;
  unitAmountDecimal: string | null;
  quantityDecimal: string | null;
  adjustmentsPresent: boolean;
}
export interface CheckoutProjection extends ObjectOwner {
  objectType: 'checkout.session';
  id: string;
  customerId: string;
  scope: ProviderScope;
  status: 'open' | 'complete' | 'expired';
  paymentStatus: 'paid' | 'unpaid' | 'no_payment_required';
  currency: string;
  amountSubtotal: number;
  amountTotal: number;
  amountTax: number;
  amountDiscount: number;
  amountShipping: number;
  automaticTaxEnabled: boolean;
  automaticTaxStatus: string | null;
  expiresAt: string;
  hostedUrl: string | null;
  lines: PriceLineProjection[];
  /** Only a fresh retrieval can supply this; a browser return is not evidence. */
  paymentConfirmed: boolean;
}
export interface InvoiceProjection extends ObjectOwner {
  objectType: 'invoice';
  id: string;
  customerId: string;
  scope: ProviderScope;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  currency: string;
  amountDue: number;
  amountPaid: number;
  amountRemaining: number;
  total: number;
  subtotal: number;
  amountShipping: number;
  exclusiveTaxTotal: number;
  totalTax: number;
  adjustmentsPresent: boolean;
  autoAdvance: boolean;
  collectionMethod: 'send_invoice' | 'charge_automatically';
  automaticTaxEnabled: boolean;
  automaticTaxStatus: string | null;
  hostedInvoiceUrl: string | null;
  lines: InvoiceLineProjection[];
  linesComplete: boolean;
}
export interface CreditNoteProjection {
  objectType: 'credit_note'; id: string; invoiceId: string; customerId: string;
  accountId: string; scope: ProviderScope; status: 'issued' | 'void'; currency: string; amount: number;
}
export interface ChargeProjection {
  objectType: 'charge'; id: string; customerId: string; accountId: string; scope: ProviderScope;
  currency: string; amount: number; amountRefunded: number; paid: boolean; captured: boolean; disputed: boolean;
}
export interface PortalProjection { id: string; customerId: string; hostedUrl: string; scope: ProviderScope }
export interface TaxPreflight {
  scope: ProviderScope;
  settingsStatus: 'active' | 'pending' | 'unknown';
  headOfficeConfigured: boolean;
  defaultTaxCodeConfigured: boolean;
  defaultTaxBehavior: string | null;
  activeRegistrationCount: number;
  registrationsComplete: boolean;
  collectionReadiness: 'not_determined_by_settings';
}
export type BillingObjectProjection = CheckoutProjection | InvoiceProjection | CustomerProjection | CreditNoteProjection | ChargeProjection;
export interface CompanyStripeProvider {
  readonly scope: ProviderScope;
  verifyAccount(): Promise<AccountProjection>;
  ensureCustomer(operation: ProviderOperation, existing: CustomerBinding | null, profile?: CustomerProfile): Promise<CustomerBinding>;
  retrieveCustomer(customerId: string): Promise<CustomerProjection>;
  createCheckout(operation: ProviderOperation, customer: CustomerBinding, lines: readonly CatalogLine[]): Promise<CheckoutProjection>;
  createDraftInvoice(operation: ProviderOperation, customer: CustomerBinding, lines: readonly CatalogLine[]): Promise<InvoiceProjection>;
  finalizeDraftInvoice(operation: ProviderOperation, customer: CustomerBinding, invoiceId: string, lines: readonly CatalogLine[]): Promise<InvoiceProjection>;
  createPortal(operation: ProviderOperation, customer: CustomerBinding): Promise<PortalProjection>;
  taxPreflight(): Promise<TaxPreflight>;
  parseSignedEvent(raw: Buffer, signature: string): VerifiedWebhook | null;
  retrieveCheckout(id: string): Promise<CheckoutProjection>;
  retrieveInvoice(id: string): Promise<InvoiceProjection>;
  retrieveVerifiedObject(event: VerifiedWebhook): Promise<BillingObjectProjection>;
}

function row(value: unknown): Row {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'stripe_response_invalid', 502);
  return value as Row;
}
function reference(value: unknown, kind: keyof typeof ids): string {
  const id = typeof value === 'string' ? value : row(value).id;
  ensure(typeof id === 'string' && id.length <= 255 && ids[kind].test(id), 'stripe_reference_invalid', 502);
  return id;
}
function integer(value: unknown): number {
  ensure(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, 'stripe_amount_invalid', 502);
  return value;
}
function text(value: unknown, max = 160): string {
  ensure(typeof value === 'string' && value.length <= max && opaque.test(value), 'stripe_binding_invalid', 502);
  return value;
}
function timestamp(value: unknown): string {
  ensure(typeof value === 'string' && value.length <= 40 && /^\d{4}-\d\d-\d\dT.*Z$/.test(value), 'stripe_timestamp_invalid', 502);
  const time = Date.parse(value);
  ensure(Number.isFinite(time), 'stripe_timestamp_invalid', 502);
  return new Date(time).toISOString();
}
function safeUrl(value: unknown, hostname: string): string | null {
  if (value === null || value === undefined) return null;
  ensure(typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u0020\u007f]/.test(value), 'stripe_url_invalid', 502);
  let url: URL;
  try { url = new URL(value); } catch { throw new BillingError('stripe_url_invalid', 502); }
  ensure(url.protocol === 'https:' && url.hostname === hostname && url.port === '' && !url.username && !url.password, 'stripe_url_invalid', 502);
  return value;
}
function sameScope(a: ProviderScope, b: ProviderScope): boolean {
  return a.application === 'company' && b.application === 'company' && a.stripeAccountId === b.stripeAccountId && a.mode === b.mode && a.configVersion === b.configVersion;
}
function currency(value: unknown): string {
  ensure(typeof value === 'string' && /^[a-z]{3}$/.test(value), 'stripe_currency_invalid', 502);
  return value;
}
function taxStatus(value: unknown): string | null {
  ensure(value === null || typeof value === 'string' && value.length <= 80 && /^[a-z_]+$/.test(value), 'stripe_tax_status_invalid', 502);
  return value as string | null;
}
function decimalString(value: Stripe.Decimal | string | null): string | null {
  if (value === null) return null;
  const result = value.toString();
  ensure(result.length <= 80 && /^\d+(?:\.\d{1,12})?$/.test(result), 'stripe_decimal_invalid', 502);
  return result;
}
function equalsIntegerDecimal(value: string | null, expected: number): boolean {
  return value !== null && /^\d+(?:\.0{1,12})?$/.test(value) && BigInt(value.split('.')[0]!) === BigInt(expected);
}
function hasEntries(value: unknown): boolean {
  if (value == null) return false;
  ensure(Array.isArray(value), 'stripe_response_invalid', 502);
  return value.length > 0;
}
function copyScope(scope: ProviderScope): ProviderScope {
  return Object.freeze({ application: scope.application, stripeAccountId: scope.stripeAccountId, mode: scope.mode, configVersion: scope.configVersion });
}
function copyOperation(value: ProviderOperation): ProviderOperation {
  return Object.freeze({ id: value.id, accountId: value.accountId, commercialIntentId: value.commercialIntentId,
    idempotencyKey: value.idempotencyKey, fingerprint: value.fingerprint, createdAt: value.createdAt,
    firstAttemptAt: value.firstAttemptAt, scope: copyScope(value.scope) });
}
function copyCustomer(value: CustomerBinding): CustomerBinding {
  return Object.freeze({ accountId: value.accountId, customerId: value.customerId, scope: copyScope(value.scope) });
}
function copyLines(lines: readonly CatalogLine[]): readonly CatalogLine[] {
  ensure(Array.isArray(lines), 'stripe_catalog_invalid');
  return Object.freeze(lines.map(({ item, quantity }) => Object.freeze({ quantity, item: Object.freeze({
    sku: item.sku, title: item.title, version: item.version, kind: item.kind, priceId: item.priceId,
    currency: item.currency, unitAmount: item.unitAmount, taxBehavior: item.taxBehavior, maxQuantity: item.maxQuantity,
  }) })));
}

/** Pure verification against a server-frozen commercial intent; no SDK call or provider mutation. */
export function validateProjectionForIntent(projection: CheckoutProjection | InvoiceProjection, lines: readonly CatalogLine[]): void {
  ensure(Array.isArray(lines) && lines.length >= 1 && lines.length <= MAX_LINES && projection.origin === 'manual', 'stripe_catalog_invalid', 409);
  for (const { item, quantity } of lines) {
    ensure(item.kind === 'one_off' && Number.isSafeInteger(item.unitAmount) && item.unitAmount > 0
      && Number.isSafeInteger(quantity) && quantity > 0 && quantity <= item.maxQuantity
      && ['inclusive', 'exclusive'].includes(item.taxBehavior), 'stripe_catalog_invalid', 409);
  }
  ensure(projection.lines.length === lines.length, 'stripe_invoice_lines_mismatch', 409);
  const wanted = lines.map(({ item, quantity }) => `${item.priceId}:${quantity}:${item.currency}`).sort();
  const got = projection.lines.map(line => `${line.priceId}:${line.quantity}:${line.currency}`).sort();
  ensure(wanted.every((value, index) => value === got[index]) && lines.every(line => line.item.currency === projection.currency), 'stripe_invoice_lines_mismatch', 409);
  if (projection.objectType === 'invoice') {
    ensure(projection.linesComplete && !projection.adjustmentsPresent && projection.amountShipping === 0
      && (projection.automaticTaxEnabled || projection.totalTax === 0 && projection.exclusiveTaxTotal === 0), 'stripe_invoice_money_mismatch', 409);
    let subtotal = 0n;
    for (const line of projection.lines) {
      const expected = lines.find(item => item.item.priceId === line.priceId && item.quantity === line.quantity && item.item.currency === line.currency);
      ensure(expected, 'stripe_invoice_money_mismatch', 409);
      const amount = BigInt(expected.item.unitAmount) * BigInt(expected.quantity); subtotal += amount;
      ensure(!line.adjustmentsPresent && equalsIntegerDecimal(line.unitAmountDecimal, expected.item.unitAmount)
        && equalsIntegerDecimal(line.quantityDecimal, expected.quantity) && BigInt(integer(line.amount)) === amount, 'stripe_invoice_money_mismatch', 409);
    }
    ensure(BigInt(integer(projection.subtotal)) === subtotal
      && BigInt(integer(projection.total)) === subtotal + BigInt(integer(projection.exclusiveTaxTotal)), 'stripe_invoice_money_mismatch', 409);
    return;
  }
  ensure(projection.objectType === 'checkout.session' && projection.amountDiscount === 0 && projection.amountShipping === 0, 'stripe_checkout_money_mismatch', 409);
  let subtotal = 0n, total = 0n, taxes = 0n;
  for (const line of projection.lines) {
    const expected = lines.find(item => item.item.priceId === line.priceId && item.quantity === line.quantity && item.item.currency === line.currency);
    ensure(expected && line.unitAmount === expected.item.unitAmount && line.taxBehavior === expected.item.taxBehavior
      && line.amountDiscount === 0 && (projection.automaticTaxEnabled || line.amountTax === 0), 'stripe_checkout_money_mismatch', 409);
    const base = BigInt(expected.item.unitAmount) * BigInt(expected.quantity), tax = BigInt(integer(line.amountTax));
    ensure(BigInt(integer(line.amountTotal)) === base + (line.taxBehavior === 'exclusive' ? tax : 0n)
      && BigInt(integer(line.amountSubtotal)) === BigInt(line.amountTotal) - tax, 'stripe_checkout_money_mismatch', 409);
    subtotal += BigInt(integer(line.amountSubtotal)); total += BigInt(integer(line.amountTotal)); taxes += tax;
  }
  ensure(BigInt(integer(projection.amountSubtotal)) === subtotal && BigInt(integer(projection.amountTotal)) === total
    && BigInt(integer(projection.amountTax)) === taxes, 'stripe_checkout_money_mismatch', 409);
}

/** The durable service reserves each operation before calling this adapter. No ledger or environment access occurs here. */
export class StripeCompanyProvider implements CompanyStripeProvider {
  readonly scope: ProviderScope;
  #client: Stripe;
  #webhookSecret: string;
  #origin: string;
  #portalConfigurationId: string | undefined;
  #daysUntilDue: number;
  #automaticTaxEnabled: boolean;
  #integrationIdentifier: string;
  #resolveExternalInvoiceOwner: StripeProviderConfig['resolveExternalInvoiceOwner'];
  #now: () => Date;

  constructor(config: StripeProviderConfig, client?: Stripe) {
    ensure(config.scope.application === 'company' && ids.account.test(config.scope.stripeAccountId) && ['test', 'live'].includes(config.scope.mode) && opaque.test(config.scope.configVersion), 'stripe_configuration_invalid');
    ensure(typeof config.secretKey === 'string' && config.secretKey.length <= 512 && new RegExp(`^(?:sk|rk)_${config.scope.mode}_[A-Za-z0-9]+$`).test(config.secretKey), 'stripe_key_mode_invalid');
    ensure(config.scope.mode === 'test' || config.liveQualified === true, 'stripe_live_unqualified');
    ensure(typeof config.webhookSecret === 'string' && /^whsec_[A-Za-z0-9]{16,512}$/.test(config.webhookSecret), 'stripe_configuration_invalid');
    let origin: URL;
    try { origin = new URL(config.publicOrigin); } catch { throw new BillingError('stripe_configuration_invalid'); }
    const testLoopback = config.scope.mode === 'test' && origin.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname);
    ensure((origin.protocol === 'https:' && !origin.port || testLoopback) && origin.pathname === '/' && !origin.search && !origin.hash && !origin.username && !origin.password, 'stripe_configuration_invalid');
    ensure(typeof config.automaticTaxEnabled === 'boolean' && /^onesa_company_[a-z]{8}$/.test(config.integrationIdentifier), 'stripe_configuration_invalid');
    ensure(config.portalConfigurationId === undefined || /^bpc_[A-Za-z0-9]+$/.test(config.portalConfigurationId), 'stripe_configuration_invalid');
    const days = config.invoiceDaysUntilDue;
    ensure(Number.isSafeInteger(days) && days >= 1 && days <= 365, 'stripe_configuration_invalid');
    this.scope = copyScope(config.scope);
    this.#origin = origin.origin;
    this.#portalConfigurationId = config.portalConfigurationId;
    this.#daysUntilDue = days;
    this.#automaticTaxEnabled = config.automaticTaxEnabled;
    this.#integrationIdentifier = config.integrationIdentifier;
    this.#resolveExternalInvoiceOwner = config.resolveExternalInvoiceOwner;
    this.#webhookSecret = config.webhookSecret;
    this.#now = config.now ?? (() => new Date());
    this.#client = client ?? new Stripe(config.secretKey, { apiVersion: STRIPE_API_VERSION, timeout: 4000, maxNetworkRetries: 0 });
  }

  async #request<T>(mutation: boolean, action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      if (error instanceof BillingError) throw error;
      // Never expose SDK message, body, request headers, URL or cause: any can contain private billing data.
      throw new BillingError(mutation ? 'stripe_outcome_unknown' : 'stripe_unavailable', 503);
    }
  }
  #mode(value: unknown): void { ensure(value === (this.scope.mode === 'live'), 'stripe_object_mode_mismatch', 409); }
  #operation(operation: ProviderOperation, customer?: CustomerBinding): void {
    ensure(sameScope(operation.scope, this.scope), 'stripe_scope_mismatch', 409);
    for (const value of [operation.id, operation.accountId, operation.commercialIntentId, operation.idempotencyKey]) ensure(typeof value === 'string' && opaque.test(value), 'stripe_operation_invalid');
    ensure(fingerprint.test(operation.fingerprint), 'stripe_operation_invalid');
    ensure(operation.firstAttemptAt !== null, 'stripe_operation_not_started', 409);
    const first = Date.parse(timestamp(operation.firstAttemptAt)), created = Date.parse(timestamp(operation.createdAt)), now = this.#now().getTime();
    ensure(created <= first && first <= now && now - first < STRIPE_OPERATION_REPLAY_MS, 'stripe_operation_replay_closed', 409);
    if (customer) ensure(customer.accountId === operation.accountId && sameScope(customer.scope, this.scope) && ids.customer.test(customer.customerId), 'stripe_customer_scope_mismatch', 409);
  }
  #key(operation: ProviderOperation, step: string): string {
    // Hashes contain opaque application identifiers only; no address/email or secret enters the provider key.
    return `onesa-company-v1-${createHash('sha256').update(JSON.stringify([this.scope.application, this.scope.stripeAccountId, this.scope.mode, this.scope.configVersion, this.#integrationIdentifier, operation.id, operation.idempotencyKey, operation.fingerprint, step])).digest('hex')}`;
  }
  #metadata(operation: ProviderOperation, kind: 'customer' | 'checkout' | 'invoice'): Stripe.MetadataParam {
    return {
      onesa_application: 'company', onesa_account_id: operation.accountId,
      onesa_integration_identifier: this.#integrationIdentifier,
      onesa_stripe_account: this.scope.stripeAccountId, onesa_config_version: this.scope.configVersion,
      onesa_operation_id: operation.id, onesa_intent_id: operation.commercialIntentId,
      onesa_fingerprint: operation.fingerprint, onesa_kind: kind,
    };
  }
  #owner(value: unknown, allowExternal = false): ObjectOwner {
    const metadata = value == null ? {} : row(value);
    if (allowExternal && metadata.onesa_application === undefined) return { accountId: '', commercialIntentId: null, operationId: null, fingerprint: null, origin: 'external' };
    ensure(metadata.onesa_application === 'company' && metadata.onesa_stripe_account === this.scope.stripeAccountId && metadata.onesa_config_version === this.scope.configVersion && metadata.onesa_integration_identifier === this.#integrationIdentifier, 'stripe_object_scope_mismatch', 409);
    ensure(typeof metadata.onesa_fingerprint === 'string' && fingerprint.test(metadata.onesa_fingerprint), 'stripe_binding_invalid', 502);
    return { accountId: text(metadata.onesa_account_id), commercialIntentId: text(metadata.onesa_intent_id), operationId: text(metadata.onesa_operation_id), fingerprint: metadata.onesa_fingerprint, origin: 'manual' };
  }
  #matchOperation(owner: ObjectOwner, operation: ProviderOperation, exactOperation: boolean): void {
    ensure(owner.accountId === operation.accountId && owner.commercialIntentId === operation.commercialIntentId && (!exactOperation || owner.operationId === operation.id && owner.fingerprint === operation.fingerprint), 'stripe_operation_binding_mismatch', 409);
  }
  async verifyAccount(): Promise<AccountProjection> {
    const account = await this.#request(false, () => this.#client.accounts.retrieve(null));
    ensure(account.object === 'account' && account.id === this.scope.stripeAccountId, 'stripe_account_mismatch', 409);
    ensure(typeof account.charges_enabled === 'boolean' && typeof account.details_submitted === 'boolean', 'stripe_response_invalid', 502);
    return { stripeAccountId: account.id, mode: this.scope.mode, chargesEnabled: account.charges_enabled, detailsSubmitted: account.details_submitted };
  }
  async #createAccountCheck(): Promise<void> {
    const account = await this.verifyAccount();
    ensure(this.scope.mode === 'test' || account.chargesEnabled, 'stripe_charges_unavailable', 409);
  }
  async ensureCustomer(operation: ProviderOperation, existing: CustomerBinding | null, profile: CustomerProfile = {}): Promise<CustomerBinding> {
    operation = copyOperation(operation); existing = existing ? copyCustomer(existing) : null;
    ensure(Object.keys(profile).every(key => key === 'name' || key === 'email'), 'stripe_profile_invalid');
    if (profile.name !== undefined) ensure(typeof profile.name === 'string' && profile.name.length >= 1 && profile.name.length <= 150 && !/[\r\n\u0000]/.test(profile.name), 'stripe_profile_invalid');
    if (profile.email !== undefined) ensure(typeof profile.email === 'string' && profile.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email), 'stripe_profile_invalid');
    profile = Object.freeze({ ...profile });
    this.#operation(operation, existing ?? undefined);
    await this.#createAccountCheck();
    if (existing) {
      const found = await this.retrieveCustomer(existing.customerId);
      ensure(found.accountId === operation.accountId, 'stripe_customer_scope_mismatch', 409);
      return { accountId: found.accountId, customerId: found.customerId, scope: this.scope };
    }
    const created = await this.#request(true, () => this.#client.customers.create({ ...profile, metadata: this.#metadata(operation, 'customer') }, { idempotencyKey: this.#key(operation, 'customer') }));
    const value = this.#customerProjection(created);
    this.#matchOperation(this.#owner(created.metadata), operation, true);
    return { accountId: value.accountId, customerId: value.customerId, scope: this.scope };
  }
  #customerProjection(input: unknown): CustomerProjection {
    const value = row(input);
    ensure(value.object === 'customer' && value.deleted !== true, 'stripe_customer_unavailable', 409);
    this.#mode(value.livemode);
    const owner = this.#owner(value.metadata);
    const tax = value.tax == null ? null : row(value.tax);
    const status = tax?.automatic_tax;
    return { ...owner, accountId: owner.accountId, customerId: reference(value.id, 'customer'), scope: this.scope,
      taxLocationStatus: typeof status === 'string' && ['supported', 'not_collecting', 'unrecognized_location', 'failed'].includes(status) ? status as CustomerProjection['taxLocationStatus'] : 'unknown' };
  }
  async retrieveCustomer(customerId: string): Promise<CustomerProjection> {
    reference(customerId, 'customer'); await this.verifyAccount();
    const value = await this.#request(false, () => this.#client.customers.retrieve(customerId, { expand: ['tax'] }));
    ensure(value.id === customerId, 'stripe_reference_mismatch', 409);
    return this.#customerProjection(value);
  }
  async #customer(binding: CustomerBinding): Promise<CustomerProjection> {
    ensure(sameScope(binding.scope, this.scope), 'stripe_scope_mismatch', 409);
    const value = await this.retrieveCustomer(binding.customerId);
    ensure(value.accountId === binding.accountId, 'stripe_customer_scope_mismatch', 409);
    return value;
  }
  #validateLines(lines: readonly CatalogLine[]): void {
    ensure(Array.isArray(lines) && lines.length >= 1 && lines.length <= MAX_LINES, 'stripe_catalog_invalid');
    const skus = new Set<string>(); let total = 0n; let denomination: string | undefined;
    for (const { item, quantity } of lines) {
      ensure(item && item.kind === 'one_off', 'stripe_metered_catalog_refused', 409);
      ensure(typeof item.sku === 'string' && typeof item.version === 'string' && opaque.test(item.sku) && opaque.test(item.version) && !skus.has(item.sku), 'stripe_catalog_invalid'); skus.add(item.sku);
      ensure(typeof item.title === 'string' && item.title.length > 0 && item.title.length <= 150 && !/[\r\n\u0000]/.test(item.title), 'stripe_catalog_invalid');
      ensure(ids.price.test(item.priceId) && /^[a-z]{3}$/.test(item.currency) && ['inclusive', 'exclusive'].includes(item.taxBehavior), 'stripe_catalog_invalid');
      ensure(Number.isSafeInteger(item.unitAmount) && item.unitAmount > 0 && Number.isSafeInteger(item.maxQuantity) && item.maxQuantity > 0 && Number.isSafeInteger(quantity) && quantity > 0 && quantity <= item.maxQuantity, 'stripe_catalog_invalid');
      denomination ??= item.currency; ensure(denomination === item.currency, 'stripe_mixed_currency_refused');
      total += BigInt(item.unitAmount) * BigInt(quantity);
    }
    ensure(total <= BigInt(Number.MAX_SAFE_INTEGER), 'stripe_catalog_amount_overflow');
  }
  async #catalog(lines: readonly CatalogLine[]): Promise<void> {
    this.#validateLines(lines);
    for (const { item } of lines) {
      const price = await this.#request(false, () => this.#client.prices.retrieve(item.priceId));
      this.#mode(price.livemode);
      ensure(price.id === item.priceId && price.active === true && price.type === 'one_time' && price.recurring === null && price.billing_scheme === 'per_unit' && price.currency === item.currency && price.unit_amount === item.unitAmount && price.tax_behavior === item.taxBehavior, 'stripe_catalog_mismatch', 409);
    }
  }
  async #taxSettings(requireActive: boolean): Promise<Stripe.Tax.Settings> {
    const settings = await this.#request(false, () => this.#client.tax.settings.retrieve());
    ensure(settings.object === 'tax.settings', 'stripe_response_invalid', 502); this.#mode(settings.livemode);
    if (requireActive) {
      ensure(settings.status === 'active' && settings.head_office !== null, 'stripe_tax_settings_incomplete', 409);
      const registrations = await this.#registrations();
      ensure(registrations.complete && registrations.count > 0, 'stripe_tax_registration_unqualified', 409);
    }
    return settings;
  }
  async #registrations(): Promise<{ count: number; complete: boolean }> {
    // One bounded page is intentional. A truncated count is never reported as complete coverage.
    const registrations = await this.#request(false, () => this.#client.tax.registrations.list({ status: 'active', limit: 100 }));
    ensure(Array.isArray(registrations.data) && registrations.data.length <= 100 && typeof registrations.has_more === 'boolean', 'stripe_response_invalid', 502);
    const seen = new Set<string>();
    for (const registration of registrations.data) {
      this.#mode(registration.livemode);
      ensure(registration.object === 'tax.registration' && registration.status === 'active' && !seen.has(registration.id), 'stripe_response_invalid', 502); seen.add(registration.id);
      ensure(Number.isSafeInteger(registration.active_from) && registration.active_from <= this.#now().getTime() / 1000 && (registration.expires_at === null || Number.isSafeInteger(registration.expires_at) && registration.expires_at > this.#now().getTime() / 1000), 'stripe_tax_registration_unqualified', 409);
    }
    return { count: registrations.data.length, complete: !registrations.has_more };
  }
  async taxPreflight(): Promise<TaxPreflight> {
    await this.verifyAccount(); const settings = await this.#taxSettings(false), registrations = await this.#registrations();
    return { scope: this.scope, settingsStatus: settings.status === 'active' ? 'active' : settings.status === 'pending' ? 'pending' : 'unknown',
      headOfficeConfigured: settings.head_office !== null, defaultTaxCodeConfigured: typeof settings.defaults.tax_code === 'string' && settings.defaults.tax_code.length > 0,
      defaultTaxBehavior: typeof settings.defaults.tax_behavior === 'string' ? settings.defaults.tax_behavior : null,
      activeRegistrationCount: registrations.count, registrationsComplete: registrations.complete, collectionReadiness: 'not_determined_by_settings' };
  }
  async createCheckout(operation: ProviderOperation, customer: CustomerBinding, lines: readonly CatalogLine[]): Promise<CheckoutProjection> {
    operation = copyOperation(operation); customer = copyCustomer(customer); lines = copyLines(lines);
    this.#operation(operation, customer); this.#validateLines(lines);
    await this.#createAccountCheck(); await this.#customer(customer); await this.#catalog(lines); if (this.#automaticTaxEnabled) await this.#taxSettings(true);
    const metadata = this.#metadata(operation, 'checkout');
    const created = await this.#request(true, () => this.#client.checkout.sessions.create({
      mode: 'payment', ui_mode: 'hosted_page', integration_identifier: this.#integrationIdentifier, customer: customer.customerId,
      line_items: lines.map(({ item, quantity }) => ({ price: item.priceId, quantity })),
      allowed_payment_method_types: ['card'], adaptive_pricing: { enabled: false }, allow_promotion_codes: false,
      automatic_tax: { enabled: this.#automaticTaxEnabled }, billing_address_collection: 'required',
      customer_update: { address: 'auto', name: 'auto' }, tax_id_collection: { enabled: true },
      invoice_creation: { enabled: false }, metadata, payment_intent_data: { metadata },
      client_reference_id: operation.commercialIntentId,
      success_url: `${this.#origin}/account/billing`, cancel_url: `${this.#origin}/account/billing`,
    }, { idempotencyKey: this.#key(operation, 'checkout') }));
    const id = reference(created.id, 'checkout.session'); this.#mode(created.livemode);
    this.#matchOperation(this.#owner(created.metadata), operation, true);
    ensure(reference(created.customer, 'customer') === customer.customerId, 'stripe_customer_scope_mismatch', 409);
    const result = await this.retrieveCheckout(id); this.#matchOperation(result, operation, true); validateProjectionForIntent(result, lines);
    return result;
  }
  #matchInvoiceMoney(invoice: InvoiceProjection, lines: readonly CatalogLine[]): void {
    validateProjectionForIntent(invoice, lines);
  }
  async retrieveCheckout(id: string): Promise<CheckoutProjection> {
    reference(id, 'checkout.session'); await this.verifyAccount();
    const value = await this.#request(false, () => this.#client.checkout.sessions.retrieve(id));
    ensure(value.id === id && value.object === 'checkout.session' && value.mode === 'payment', 'stripe_response_invalid', 502); this.#mode(value.livemode);
    const owner = this.#owner(value.metadata), customerId = reference(value.customer, 'customer');
    await this.#customer({ accountId: owner.accountId, customerId, scope: this.scope });
    ensure(value.client_reference_id === owner.commercialIntentId && value.integration_identifier === this.#integrationIdentifier && value.automatic_tax.enabled === this.#automaticTaxEnabled, 'stripe_checkout_binding_mismatch', 409);
    ensure(['open', 'complete', 'expired'].includes(value.status ?? '') && ['paid', 'unpaid', 'no_payment_required'].includes(value.payment_status), 'stripe_response_invalid', 502);
    const inventory = await this.#request(false, () => this.#client.checkout.sessions.listLineItems(id, { limit: MAX_LINES + 1, expand: ['data.price'] }));
    ensure(inventory.has_more === false && inventory.data.length >= 1 && inventory.data.length <= MAX_LINES, 'stripe_line_inventory_incomplete', 502);
    const lines = inventory.data.map(line => {
      ensure(line.price !== null, 'stripe_line_inventory_incomplete', 502); this.#mode(line.price.livemode);
      ensure(line.price.type === 'one_time' && line.price.currency === line.currency, 'stripe_catalog_mismatch', 409);
      const quantity = integer(line.quantity); ensure(quantity > 0, 'stripe_response_invalid', 502);
      ensure(line.price.tax_behavior === 'inclusive' || line.price.tax_behavior === 'exclusive', 'stripe_catalog_mismatch', 409);
      return { priceId: reference(line.price.id, 'price'), quantity, currency: currency(line.currency),
        unitAmount: integer(line.price.unit_amount), taxBehavior: line.price.tax_behavior as 'inclusive' | 'exclusive',
        amountSubtotal: integer(line.amount_subtotal), amountTotal: integer(line.amount_total),
        amountTax: integer(line.amount_tax), amountDiscount: integer(line.amount_discount) };
    });
    const denomination = currency(value.currency); ensure(lines.every(line => line.currency === denomination), 'stripe_currency_invalid', 502);
    const status = value.status as CheckoutProjection['status'], automaticTaxStatus = taxStatus(value.automatic_tax.status);
    const expires = integer(value.expires_at); ensure(expires > 0 && expires < 253402300800, 'stripe_timestamp_invalid', 502);
    return { ...owner, objectType: 'checkout.session', id, customerId, scope: this.scope, status,
      paymentStatus: value.payment_status as CheckoutProjection['paymentStatus'], currency: denomination,
      amountSubtotal: integer(value.amount_subtotal), amountTotal: integer(value.amount_total),
      amountTax: integer(value.total_details?.amount_tax), amountDiscount: integer(value.total_details?.amount_discount),
      amountShipping: integer(value.total_details?.amount_shipping), automaticTaxEnabled: value.automatic_tax.enabled, automaticTaxStatus,
      expiresAt: new Date(expires * 1000).toISOString(), hostedUrl: safeUrl(value.url, 'checkout.stripe.com'), lines,
      paymentConfirmed: status === 'complete' && value.payment_status === 'paid' && (!this.#automaticTaxEnabled || automaticTaxStatus === 'complete') };
  }
  async createDraftInvoice(operation: ProviderOperation, customer: CustomerBinding, lines: readonly CatalogLine[]): Promise<InvoiceProjection> {
    operation = copyOperation(operation); customer = copyCustomer(customer); lines = copyLines(lines);
    this.#operation(operation, customer); this.#validateLines(lines);
    await this.#createAccountCheck(); await this.#customer(customer); await this.#catalog(lines); if (this.#automaticTaxEnabled) await this.#taxSettings(true);
    const created = await this.#request(true, () => this.#client.invoices.create({
      customer: customer.customerId, collection_method: 'send_invoice', days_until_due: this.#daysUntilDue,
      auto_advance: false, pending_invoice_items_behavior: 'exclude', automatic_tax: { enabled: this.#automaticTaxEnabled },
      currency: lines[0]!.item.currency, discounts: [], metadata: this.#metadata(operation, 'invoice'),
    }, { idempotencyKey: this.#key(operation, 'invoice') }));
    const invoiceId = reference(created.id, 'invoice'); this.#mode(created.livemode);
    this.#matchOperation(this.#owner(created.metadata), operation, true);
    ensure(created.status === 'draft' && created.auto_advance === false && created.collection_method === 'send_invoice' && reference(created.customer, 'customer') === customer.customerId, 'stripe_invoice_not_draft', 409);
    for (const [index, { item, quantity }] of lines.entries()) {
      // A separate immutable child key makes a partial draft resumable without adding a line twice.
      const line = await this.#request(true, () => this.#client.invoiceItems.create({
        customer: customer.customerId, invoice: invoiceId, pricing: { price: item.priceId }, quantity,
        metadata: { ...this.#metadata(operation, 'invoice'), onesa_sku: item.sku, onesa_catalog_version: item.version },
      }, { idempotencyKey: this.#key(operation, `invoice-line:${index}:${item.sku}`) }));
      this.#mode(line.livemode);
      ensure(line.object === 'invoiceitem' && ids.invoiceitem.test(line.id) && reference(line.invoice, 'invoice') === invoiceId && reference(line.customer, 'customer') === customer.customerId && line.currency === item.currency, 'stripe_invoice_line_binding_mismatch', 409);
      this.#matchOperation(this.#owner(line.metadata), operation, true);
    }
    const result = await this.retrieveInvoice(invoiceId); this.#matchOperation(result, operation, true); this.#matchInvoiceMoney(result, lines);
    ensure(result.status === 'draft' && result.autoAdvance === false && result.collectionMethod === 'send_invoice' && result.automaticTaxEnabled === this.#automaticTaxEnabled, 'stripe_invoice_not_draft', 409);
    return result;
  }
  async finalizeDraftInvoice(operation: ProviderOperation, customer: CustomerBinding, invoiceId: string, lines: readonly CatalogLine[]): Promise<InvoiceProjection> {
    operation = copyOperation(operation); customer = copyCustomer(customer); lines = copyLines(lines);
    this.#operation(operation, customer); this.#validateLines(lines);
    await this.#createAccountCheck(); await this.#customer(customer); await this.#catalog(lines); if (this.#automaticTaxEnabled) await this.#taxSettings(true);
    const before = await this.retrieveInvoice(invoiceId); this.#matchOperation(before, operation, false); this.#matchInvoiceMoney(before, lines);
    ensure(before.customerId === customer.customerId && before.collectionMethod === 'send_invoice' && !before.autoAdvance && before.automaticTaxEnabled === this.#automaticTaxEnabled, 'stripe_invoice_binding_mismatch', 409);
    ensure(['draft', 'open', 'paid'].includes(before.status), 'stripe_invoice_not_finalizable', 409);
    if (before.status === 'draft') {
      const finalized = await this.#request(true, () => this.#client.invoices.finalizeInvoice(invoiceId, { auto_advance: false }, { idempotencyKey: this.#key(operation, 'invoice-finalize') }));
      ensure(finalized.id === invoiceId, 'stripe_reference_mismatch', 409); this.#mode(finalized.livemode);
    }
    const result = await this.retrieveInvoice(invoiceId); this.#matchOperation(result, operation, false); this.#matchInvoiceMoney(result, lines);
    ensure(['open', 'paid'].includes(result.status) && !result.autoAdvance && result.collectionMethod === 'send_invoice' && result.automaticTaxEnabled === this.#automaticTaxEnabled && (!this.#automaticTaxEnabled || result.automaticTaxStatus === 'complete'), 'stripe_invoice_finalization_unconfirmed', 409);
    return result; // No send, pay, subscription, meter or usage-invoice API is exposed by this adapter.
  }
  async retrieveInvoice(id: string): Promise<InvoiceProjection> {
    reference(id, 'invoice'); await this.verifyAccount();
    const value = await this.#request(false, () => this.#client.invoices.retrieve(id));
    ensure(value.object === 'invoice' && value.id === id, 'stripe_response_invalid', 502); this.#mode(value.livemode);
    const customerId = reference(value.customer, 'customer'), customer = await this.retrieveCustomer(customerId);
    const owner = this.#owner(value.metadata, true);
    ensure(owner.origin === 'external' || owner.accountId === customer.accountId, 'stripe_customer_scope_mismatch', 409);
    if (owner.origin === 'external') {
      ensure(this.#resolveExternalInvoiceOwner, 'stripe_external_invoice_unbound', 409);
      const binding = await this.#request(false, () => this.#resolveExternalInvoiceOwner!(id, customerId));
      ensure(binding && binding.source === 'metronome' && binding.invoiceId === id && binding.customerId === customerId && binding.accountId === customer.accountId && sameScope(binding.scope, this.scope) && binding.integrationIdentifier === this.#integrationIdentifier, 'stripe_external_invoice_unbound', 409);
    }
    owner.accountId = customer.accountId;
    ensure(['draft', 'open', 'paid', 'void', 'uncollectible'].includes(value.status ?? '') && typeof value.auto_advance === 'boolean' && ['send_invoice', 'charge_automatically'].includes(value.collection_method), 'stripe_response_invalid', 502);
    const inventory = await this.#request(false, () => this.#client.invoices.listLineItems(id, { limit: owner.origin === 'manual' ? MAX_LINES + 1 : 100 }));
    ensure(Array.isArray(inventory.data) && inventory.data.length <= (owner.origin === 'manual' ? MAX_LINES : 100) && typeof inventory.has_more === 'boolean', 'stripe_line_inventory_incomplete', 502);
    if (owner.origin === 'manual') ensure(!inventory.has_more, 'stripe_line_inventory_incomplete', 502);
    const lines = inventory.data.map(line => {
      this.#mode(line.livemode);
      const pricing = line.pricing == null ? null : row(line.pricing), details = pricing?.price_details == null ? null : row(pricing.price_details);
      const quantity = line.quantity == null ? null : integer(line.quantity);
      const priceId = details?.price == null ? null : reference(details.price, 'price');
      if (owner.origin === 'manual') ensure(quantity !== null && quantity > 0 && priceId !== null, 'stripe_response_invalid', 502);
      return { priceId, quantity, currency: currency(line.currency), amount: integer(line.amount),
        unitAmountDecimal: decimalString(pricing?.unit_amount_decimal as Stripe.Decimal | string | null ?? null),
        quantityDecimal: decimalString(line.quantity_decimal),
        adjustmentsPresent: hasEntries(line.discounts) || hasEntries(line.discount_amounts) || hasEntries(line.pretax_credit_amounts) };
    });
    const denomination = currency(value.currency); ensure(lines.every(line => line.currency === denomination), 'stripe_currency_invalid', 502);
    let exclusiveTaxTotal = 0, totalTax = 0;
    if (value.total_taxes !== null) {
      ensure(Array.isArray(value.total_taxes), 'stripe_response_invalid', 502);
      for (const tax of value.total_taxes) {
        ensure(['inclusive', 'exclusive'].includes(tax.tax_behavior), 'stripe_tax_status_invalid', 502);
        const amount = integer(tax.amount); totalTax += amount; if (tax.tax_behavior === 'exclusive') exclusiveTaxTotal += amount;
      }
    }
    integer(exclusiveTaxTotal); integer(totalTax);
    return { ...owner, objectType: 'invoice', id, customerId, scope: this.scope, status: value.status as InvoiceProjection['status'],
      currency: denomination, amountDue: integer(value.amount_due), amountPaid: integer(value.amount_paid), amountRemaining: integer(value.amount_remaining), total: integer(value.total),
      subtotal: integer(value.subtotal), amountShipping: integer(value.amount_shipping), exclusiveTaxTotal, totalTax,
      adjustmentsPresent: hasEntries(value.discounts) || hasEntries(value.total_discount_amounts) || hasEntries(value.total_pretax_credit_amounts) || value.shipping_cost !== null,
      autoAdvance: value.auto_advance, collectionMethod: value.collection_method as InvoiceProjection['collectionMethod'],
      automaticTaxEnabled: value.automatic_tax.enabled === true, automaticTaxStatus: taxStatus(value.automatic_tax.status),
      hostedInvoiceUrl: safeUrl(value.hosted_invoice_url, 'invoice.stripe.com'), lines, linesComplete: !inventory.has_more };
  }
  async createPortal(operation: ProviderOperation, customer: CustomerBinding): Promise<PortalProjection> {
    operation = copyOperation(operation); customer = copyCustomer(customer);
    this.#operation(operation, customer); ensure(this.#portalConfigurationId, 'stripe_portal_unconfigured', 409);
    await this.#createAccountCheck(); await this.#customer(customer);
    const configuration = await this.#request(false, () => this.#client.billingPortal.configurations.retrieve(this.#portalConfigurationId!));
    this.#mode(configuration.livemode); ensure(configuration.id === this.#portalConfigurationId && configuration.active, 'stripe_portal_configuration_unavailable', 409);
    const session = await this.#request(true, () => this.#client.billingPortal.sessions.create({
      customer: customer.customerId, configuration: this.#portalConfigurationId, return_url: `${this.#origin}/account/billing`,
    }, { idempotencyKey: this.#key(operation, 'portal') }));
    ensure(session.object === 'billing_portal.session' && /^bps_[A-Za-z0-9]+$/.test(session.id) && session.customer === customer.customerId && session.customer_account === null && session.return_url === `${this.#origin}/account/billing`, 'stripe_portal_binding_mismatch', 409);
    const configured = typeof session.configuration === 'string' ? session.configuration : session.configuration.id;
    ensure(configured === this.#portalConfigurationId, 'stripe_portal_binding_mismatch', 409);
    const url = safeUrl(session.url, 'billing.stripe.com'); ensure(url, 'stripe_url_invalid', 502);
    return { id: session.id, customerId: customer.customerId, hostedUrl: url, scope: this.scope };
  }
  parseSignedEvent(raw: Buffer, signature: string): VerifiedWebhook | null {
    ensure(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= MAX_WEBHOOK_BYTES && typeof signature === 'string' && signature.length <= 4096, 'stripe_webhook_invalid');
    const times = [...signature.matchAll(/(?:^|,)t=(\d+)(?=,|$)/g)];
    ensure(times.length === 1 && Math.abs(this.#now().getTime() / 1000 - Number(times[0]![1])) <= 300, 'stripe_webhook_invalid');
    let shape: Row; let verified: Row; let format: 'snapshot' | 'thin';
    try {
      shape = row(JSON.parse(raw.toString('utf8')));
      if (shape.object === 'event') {
        verified = row(this.#client.webhooks.constructEvent(raw, signature, this.#webhookSecret, 300, undefined, this.#now().getTime())); format = 'snapshot';
        ensure(verified.api_version === STRIPE_API_VERSION, 'stripe_webhook_version_unsupported');
      } else {
        ensure(shape.object === 'v2.core.event', 'stripe_webhook_format_unsupported');
        verified = row(this.#client.parseEventNotification(raw, signature, this.#webhookSecret, 300, undefined, this.#now().getTime())); format = 'thin';
      }
    } catch (error) {
      if (error instanceof BillingError) throw error;
      throw new BillingError('stripe_webhook_invalid');
    }
    this.#mode(verified.livemode);
    ensure(shape.account == null && (shape.context == null || shape.context === this.scope.stripeAccountId), 'stripe_webhook_account_mismatch', 409);
    const eventId = reference(verified.id, 'event');
    ensure(typeof verified.type === 'string', 'stripe_webhook_invalid');
    const type = format === 'thin' && verified.type.startsWith('v1.') ? verified.type.slice(3) : verified.type;
    const objectType = Object.hasOwn(eventObjects, type) ? eventObjects[type] : undefined; if (!objectType) return null;
    let objectId: string; let createdAt: string;
    if (format === 'snapshot') {
      const resource = row(row(verified.data).object); ensure(resource.object === objectType, 'stripe_webhook_object_mismatch');
      objectId = reference(resource.id, objectType);
      const created = integer(verified.created); ensure(created > 0 && created < 253402300800, 'stripe_webhook_invalid'); createdAt = new Date(created * 1000).toISOString();
    } else {
      ensure(verified.type.startsWith('v1.'), 'stripe_webhook_type_unsupported');
      const related = row(verified.related_object); objectId = reference(related.id, objectType);
      ensure(related.type === objectType || related.type === `v1.${objectType}`, 'stripe_webhook_object_mismatch');
      const endpoint = objectType === 'checkout.session' ? 'checkout/sessions' : objectType === 'credit_note' ? 'credit_notes' : `${objectType}s`;
      ensure(related.url === `/v1/${endpoint}/${objectId}`, 'stripe_webhook_resource_url_mismatch');
      createdAt = timestamp(verified.created);
    }
    ensure(Date.parse(createdAt) <= this.#now().getTime() + 300_000, 'stripe_webhook_invalid');
    return { stripeAccountId: this.scope.stripeAccountId, mode: this.scope.mode, eventId, type, objectId, objectType, createdAt,
      bodySha256: createHash('sha256').update(raw).digest('hex'), format };
  }
  async retrieveVerifiedObject(event: VerifiedWebhook): Promise<BillingObjectProjection> {
    ensure(event.stripeAccountId === this.scope.stripeAccountId && event.mode === this.scope.mode && Object.hasOwn(eventObjects, event.type) && eventObjects[event.type] === event.objectType, 'stripe_webhook_scope_mismatch', 409);
    if (event.objectType === 'checkout.session') return this.retrieveCheckout(event.objectId);
    if (event.objectType === 'invoice') return this.retrieveInvoice(event.objectId);
    if (event.objectType === 'customer') return this.retrieveCustomer(event.objectId);
    await this.verifyAccount();
    if (event.objectType === 'credit_note') {
      const id = reference(event.objectId, 'credit_note'), value = await this.#request(false, () => this.#client.creditNotes.retrieve(id)); this.#mode(value.livemode);
      ensure(value.id === id && value.object === 'credit_note' && ['issued', 'void'].includes(value.status), 'stripe_response_invalid', 502);
      const invoiceId = reference(value.invoice, 'invoice'), invoice = await this.retrieveInvoice(invoiceId);
      const customerId = reference(value.customer, 'customer'); ensure(customerId === invoice.customerId && value.currency === invoice.currency, 'stripe_credit_note_binding_mismatch', 409);
      return { objectType: 'credit_note', id, invoiceId, customerId, accountId: invoice.accountId, scope: this.scope, status: value.status as CreditNoteProjection['status'], currency: currency(value.currency), amount: integer(value.amount) };
    }
    const id = reference(event.objectId, 'charge'), value = await this.#request(false, () => this.#client.charges.retrieve(id)); this.#mode(value.livemode);
    ensure(value.id === id && value.object === 'charge', 'stripe_response_invalid', 502);
    const customerId = reference(value.customer, 'customer'), customer = await this.retrieveCustomer(customerId);
    ensure(typeof value.paid === 'boolean' && typeof value.captured === 'boolean' && typeof value.disputed === 'boolean', 'stripe_response_invalid', 502);
    const amount = integer(value.amount), amountRefunded = integer(value.amount_refunded); ensure(amountRefunded <= amount, 'stripe_amount_invalid', 502);
    return { objectType: 'charge', id, customerId, accountId: customer.accountId, scope: this.scope, currency: currency(value.currency), amount, amountRefunded, paid: value.paid, captured: value.captured, disputed: value.disputed };
  }
}
