/** Company billing is separate from product operational authority. */
export type Mode = 'test' | 'live';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ProviderScope {
  application: 'company';
  stripeAccountId: string;
  mode: Mode;
  configVersion: string;
}
export interface Actor {
  issuer: string;
  subject: string;
}
export type BillingRole = 'owner' | 'payer' | 'viewer';
export interface ProviderOperation {
  id: string;
  accountId: string;
  commercialIntentId: string;
  idempotencyKey: string;
  fingerprint: string;
  createdAt: string;
  firstAttemptAt: string | null;
  scope: ProviderScope;
}
export interface CatalogItem {
  sku: string;
  title: string;
  version: string;
  kind: 'one_off' | 'metered';
  priceId: string;
  currency: string;
  unitAmount: number;
  taxBehavior: 'inclusive' | 'exclusive';
  maxQuantity: number;
}
export interface CatalogLine {
  item: CatalogItem;
  quantity: number;
}
export interface CustomerBinding {
  accountId: string;
  customerId: string;
  scope: ProviderScope;
}
export interface VerifiedWebhook {
  stripeAccountId: string;
  mode: Mode;
  eventId: string;
  type: string;
  objectId: string;
  objectType: 'checkout.session' | 'invoice' | 'customer' | 'credit_note' | 'charge';
  createdAt: string;
  bodySha256: string;
  format: 'snapshot' | 'thin';
}
export class BillingError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 400) {
    super(code);
    this.name = 'BillingError';
  }
}
export function ensure(condition: unknown, code: string, statusCode = 400): asserts condition {
  if (!condition) throw new BillingError(code, statusCode);
}
