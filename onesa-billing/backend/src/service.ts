import { BillingError, ensure, type Actor, type CatalogLine, type CustomerBinding, type Json } from './domain.js';
import type { BillingConfig } from './config.js';
import { BillingStore, type StoredOperation, type VerifiedOperationResult } from './store.js';
import type { CompanyStripeProvider, CheckoutProjection, InvoiceProjection, CustomerProjection } from './stripe-provider.js';
import { validateProjectionForIntent } from './stripe-provider.js';

export interface OperationView {
  id: string; accountId: string; commercialIntentId: string;
  kind: StoredOperation['kind']; state: StoredOperation['state'];
  providerState: string | null; reviewRequired: boolean;
  redirectUrl?: string | null; paymentConfirmed?: boolean;
  amountMinor?: number; currency?: string;
}

function view(operation: StoredOperation): OperationView {
  return { id: operation.id, accountId: operation.accountId, commercialIntentId: operation.commercialIntentId,
    kind: operation.kind, state: operation.state, providerState: operation.providerState,
    reviewRequired: operation.state === 'unknown' || operation.state === 'failed' };
}
function binding(value: CheckoutProjection | InvoiceProjection | CustomerProjection): CustomerBinding {
  return { accountId: value.accountId, customerId: value.customerId, scope: value.scope };
}
function providerResult(value: CheckoutProjection | InvoiceProjection | CustomerProjection): VerifiedOperationResult {
  if (!('objectType' in value)) return { binding: binding(value), objectId: value.customerId, objectType: 'customer', state: 'created' };
  if (value.objectType === 'checkout.session') return { binding: binding(value), objectId: value.id, objectType: value.objectType,
    state: `${value.status}.${value.paymentStatus}`, amountMinor: value.amountTotal, currency: value.currency };
  return { binding: binding(value), objectId: value.id, objectType: value.objectType,
    state: value.status, amountMinor: value.total, currency: value.currency };
}
function verifyOwner(value: CheckoutProjection | InvoiceProjection | CustomerProjection, operation: StoredOperation): void {
  ensure(value.accountId === operation.accountId && value.commercialIntentId === operation.commercialIntentId
    && value.scope.application === operation.scope.application
    && value.scope.stripeAccountId === operation.scope.stripeAccountId && value.scope.mode === operation.scope.mode
    && value.scope.configVersion === operation.scope.configVersion && value.origin === 'manual', 'BILLING_RESOURCE_OWNERSHIP', 409);
  if (operation.kind !== 'invoice_finalize') ensure(value.operationId === operation.id && value.fingerprint === operation.fingerprint,
    'BILLING_RESOURCE_OWNERSHIP', 409);
  else ensure(value.operationId === operation.frozenRequest.draftOperationId
    && value.fingerprint === operation.frozenRequest.draftFingerprint, 'BILLING_RESOURCE_OWNERSHIP', 409);
}

/** Commands reference frozen local intents. Provider IDs, prices and amounts are never browser authority. */
export class BillingService {
  constructor(readonly config: BillingConfig, readonly store: BillingStore, readonly provider: CompanyStripeProvider) {}

  selectLines(items: unknown): CatalogLine[] {
    ensure(Array.isArray(items) && items.length > 0 && items.length <= 8, 'INVALID_ITEMS');
    const seen = new Set<string>();
    const lines = items.map((value: unknown) => {
      ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_ITEMS');
      const item = value as Record<string, unknown>;
      ensure(Object.keys(item).length === 2 && typeof item.sku === 'string' && Object.hasOwn(item, 'quantity'), 'INVALID_ITEMS');
      const offer = this.config.catalog.find(entry => entry.sku === item.sku);
      ensure(offer && offer.kind === 'one_off' && !seen.has(offer.sku), 'OFFER_UNAVAILABLE', 409);
      ensure(typeof item.quantity === 'number' && Number.isSafeInteger(item.quantity) && item.quantity >= 1 && item.quantity <= offer.maxQuantity,
        'INVALID_QUANTITY');
      seen.add(offer.sku); return { item: { ...offer }, quantity: item.quantity };
    });
    ensure(new Set(lines.map(line => line.item.currency)).size === 1, 'MIXED_CURRENCY');
    ensure(lines.every(line => Number.isSafeInteger(line.item.unitAmount * line.quantity)), 'INVALID_AMOUNT');
    return lines;
  }

  async prepareCustomer(actor: Actor, accountId: string): Promise<OperationView> {
    const { operation } = await this.store.prepareOperation(actor, { accountId, commercialIntentId: accountId,
      kind: 'customer_create', clientKey: 'account-customer', frozenRequest: {} });
    return view(operation);
  }
  async createIntent(actor: Actor, accountId: string, kind: 'checkout' | 'invoice' | 'portal', clientKey: string, items: unknown) {
    ensure(this.config.salesEnabled || kind === 'portal', 'SALES_PAUSED', 503);
    if (kind === 'portal') ensure(this.config.portalConfigurationId, 'PORTAL_NOT_CONFIGURED', 503);
    const lines = kind === 'portal' ? [] : this.selectLines(items);
    const frozenRequest: Record<string, Json> = { automaticTaxEnabled: this.config.taxEnabled,
      invoiceDaysUntilDue: this.config.invoiceDaysUntilDue, integrationIdentifier: this.config.integrationIdentifier };
    return this.store.createCommercialIntent(actor, { accountId, kind, clientKey, lines, frozenRequest });
  }
  async submitIntent(actor: Actor, accountId: string, intentId: string, clientKey: string): Promise<OperationView> {
    const intent = await this.store.getCommercialIntent(actor, accountId, intentId);
    ensure(intent.kind !== 'customer', 'INVALID_COMMERCIAL_INTENT');
    ensure(this.config.salesEnabled || intent.kind === 'portal', 'SALES_PAUSED', 503);
    const customer = await this.store.getCustomer(actor, accountId);
    ensure(customer, 'CUSTOMER_PENDING', 409);
    const { operation } = await this.store.prepareOperation(actor, { accountId, commercialIntentId: intent.id,
      kind: intent.kind === 'checkout' ? 'checkout_create' : intent.kind === 'invoice' ? 'invoice_create' : 'portal_create',
      clientKey, frozenRequest: { ...intent.frozenRequest, customerId: customer.customerId } });
    return view(operation);
  }
  async finalizeInvoice(actor: Actor, accountId: string, draftOperationId: string, clientKey: string): Promise<OperationView> {
    ensure(this.config.salesEnabled, 'SALES_PAUSED', 503);
    await this.store.getAccountForActor(actor, accountId, 'owner');
    const draft = await this.store.getOperation(actor, draftOperationId);
    ensure(draft.accountId === accountId && draft.kind === 'invoice_create' && draft.state === 'succeeded'
      && draft.providerObjectType === 'invoice' && draft.providerObjectId, 'DRAFT_NOT_READY', 409);
    const { operation } = await this.store.prepareOperation(actor, { accountId, commercialIntentId: draft.commercialIntentId,
      kind: 'invoice_finalize', clientKey, frozenRequest: { ...draft.frozenRequest, invoiceId: draft.providerObjectId,
        draftOperationId: draft.id, draftFingerprint: draft.fingerprint } });
    return view(operation);
  }
  async getOperation(actor: Actor, id: string): Promise<OperationView> {
    const operation = await this.store.getOperation(actor, id), result = view(operation);
    if (operation.state !== 'succeeded' || !operation.providerObjectId) return result;
    const account = await this.store.getAccountForActor(actor, operation.accountId);
    const canPay = account.status === 'active' && (account.role === 'owner' || account.role === 'payer');
    if (operation.providerObjectType === 'checkout.session') {
      const current = await this.provider.retrieveCheckout(operation.providerObjectId); verifyOwner(current, operation);
      const intent = await this.store.getCommercialIntent(actor, operation.accountId, operation.commercialIntentId);
      validateProjectionForIntent(current, intent.lines);
      ensure(current.automaticTaxEnabled === intent.frozenRequest.automaticTaxEnabled, 'BILLING_TAX_CONFIGURATION_MISMATCH', 409);
      if (current.paymentConfirmed) ensure(!current.automaticTaxEnabled || current.automaticTaxStatus === 'complete', 'BILLING_TAX_INCOMPLETE', 409);
      return { ...result, providerState: `${current.status}.${current.paymentStatus}`, redirectUrl: canPay && current.status === 'open' ? current.hostedUrl : null,
        paymentConfirmed: current.paymentConfirmed, amountMinor: current.amountTotal, currency: current.currency };
    }
    if (operation.providerObjectType === 'invoice') {
      const current = await this.provider.retrieveInvoice(operation.providerObjectId); verifyOwner(current, operation);
      const intent = await this.store.getCommercialIntent(actor, operation.accountId, operation.commercialIntentId);
      validateProjectionForIntent(current, intent.lines);
      ensure(current.automaticTaxEnabled === intent.frozenRequest.automaticTaxEnabled, 'BILLING_TAX_CONFIGURATION_MISMATCH', 409);
      ensure(!current.autoAdvance && current.collectionMethod === 'send_invoice', 'BILLING_INVOICE_POLICY_MISMATCH', 409);
      if (current.status === 'open' || current.status === 'paid') ensure(!current.automaticTaxEnabled
        || current.automaticTaxStatus === 'complete', 'BILLING_TAX_INCOMPLETE', 409);
      return { ...result, providerState: current.status, redirectUrl: canPay ? current.hostedInvoiceUrl : null,
        paymentConfirmed: current.status === 'paid' && current.amountRemaining === 0, amountMinor: current.total, currency: current.currency };
    }
    return result;
  }
  async listOperations(actor: Actor, accountId: string): Promise<OperationView[]> {
    return (await this.store.listOperations(actor, accountId)).map(view);
  }

  /** Called by the worker or explicit portal command; a timeout is held, never resubmitted with another key. */
  async dispatchNext(operationId?: string): Promise<{ processed: boolean; operationId?: string; redirectUrl?: string }> {
    const lease = await this.store.claimOperation({ operationId, leaseMs: 180_000 });
    if (!lease) return { processed: false };
    try {
      const { operation, intent, customer } = await this.store.getDispatchContext(lease);
      if (operation.kind === 'customer_create') {
        const created = await this.provider.ensureCustomer(operation, customer);
        await this.store.bindCustomer(lease, created);
      } else {
        ensure(this.config.salesEnabled || operation.kind === 'portal_create', 'SALES_PAUSED', 503);
        ensure(customer && operation.frozenRequest.customerId === customer.customerId, 'BILLING_RESOURCE_OWNERSHIP', 409);
        ensure(intent.frozenRequest.automaticTaxEnabled === this.config.taxEnabled
          && intent.frozenRequest.invoiceDaysUntilDue === this.config.invoiceDaysUntilDue
          && intent.frozenRequest.integrationIdentifier === this.config.integrationIdentifier,
          'BILLING_CONFIGURATION_CHANGED', 409);
        if (operation.kind === 'portal_create') {
          const portal = await this.provider.createPortal(operation, customer);
          await this.store.completeOperation(lease, { binding: customer, objectId: portal.id, objectType: 'billing_portal.session', state: 'created' });
          return { processed: true, operationId: operation.id, redirectUrl: portal.hostedUrl };
        }
        let result: CheckoutProjection | InvoiceProjection;
        if (operation.kind === 'checkout_create') result = await this.provider.createCheckout(operation, customer, intent.lines);
        else if (operation.kind === 'invoice_create') result = await this.provider.createDraftInvoice(operation, customer, intent.lines);
        else {
          ensure(operation.kind === 'invoice_finalize' && typeof operation.frozenRequest.invoiceId === 'string', 'INVALID_BILLING_OPERATION');
          result = await this.provider.finalizeDraftInvoice(operation, customer, operation.frozenRequest.invoiceId, intent.lines);
        }
        verifyOwner(result, operation);
        await this.store.completeOperation(lease, providerResult(result));
      }
      return { processed: true, operationId: lease.operation.id };
    } catch (error) {
      // A provider may have committed before the connection failed. Keep the same immutable intent for reconciliation.
      await this.store.holdOperation(lease, error instanceof BillingError && error.code === 'BILLING_CONFIGURATION_CHANGED'
        ? 'configuration_changed' : 'result_unverified').catch(() => undefined);
      return { processed: true, operationId: lease.operation.id };
    }
  }

  async reconcileNext(): Promise<boolean> {
    const claim = await this.store.claimReconciliation(180_000);
    if (!claim) return false;
    try {
      const current = await this.provider.retrieveVerifiedObject(claim.event);
      if ('objectType' in current && current.objectType === 'credit_note') {
        await this.store.recordCreditNoteObservation(claim, {
          binding: { accountId: current.accountId, customerId: current.customerId, scope: current.scope },
          objectId: current.id, invoiceId: current.invoiceId, state: current.status,
          amountMinor: current.amount, currency: current.currency,
        });
        return true;
      }
      if ('objectType' in current && current.objectType === 'charge') {
        // Customer equality alone does not establish the charge's exact invoice/payment association.
        await this.store.holdReconciliation(claim, 'unbound_resource'); return true;
      }
      const owned = current as CheckoutProjection | InvoiceProjection | CustomerProjection;
      ensure('operationId' in owned && typeof owned.operationId === 'string' && typeof owned.fingerprint === 'string', 'BILLING_UNBOUND_RESOURCE', 409);
      const context = await this.store.getReconciliationContext(claim, owned.operationId, {
        accountId: owned.accountId, fingerprint: owned.fingerprint, customerId: owned.customerId,
      });
      verifyOwner(owned, context.operation);
      if ('objectType' in owned) {
        validateProjectionForIntent(owned, context.intent.lines);
        ensure(owned.automaticTaxEnabled === context.intent.frozenRequest.automaticTaxEnabled, 'BILLING_TAX_CONFIGURATION_MISMATCH', 409);
      }
      const result = providerResult(owned);
      if ('objectType' in owned && owned.objectType === 'invoice') {
        ensure(!owned.autoAdvance && owned.collectionMethod === 'send_invoice', 'BILLING_INVOICE_POLICY_MISMATCH', 409);
        if (owned.status === 'open' || owned.status === 'paid') {
          ensure(!owned.automaticTaxEnabled || owned.automaticTaxStatus === 'complete', 'BILLING_TAX_INCOMPLETE', 409);
          await this.store.completeInvoiceReconciliation(claim, { ...result, operationId: context.operation.id }, {
            commercialIntentId: context.intent.id, creationFingerprint: context.operation.fingerprint,
            intentFingerprint: context.intent.fingerprint,
          });
          return true;
        }
      }
      await this.store.completeReconciliation(claim, { ...result, operationId: context.operation.id });
    } catch (error) {
      if (error instanceof BillingError && error.code === 'stripe_unavailable') {
        await this.store.retryReconciliation(claim).catch(() => undefined);
      } else {
        await this.store.holdReconciliation(claim, 'ownership_mismatch').catch(() => undefined);
      }
    }
    return true;
  }
}
