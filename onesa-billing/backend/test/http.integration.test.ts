import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import Stripe from 'stripe';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { BillingError, type CatalogLine, type CustomerBinding, type ProviderOperation, type ProviderScope } from '../src/domain.js';
import { BillingSecrets, type BillingConfig } from '../src/config.js';
import { BillingStore, verifyStorePoolRoles, type StorePools } from '../src/store.js';
import { BillingService } from '../src/service.js';
import { buildApp } from '../src/app.js';
import { migrate, verifyMigration } from '../src/migrate.js';
import { StripeCompanyProvider, STRIPE_API_VERSION, type CompanyStripeProvider, type CustomerProjection,
  type CheckoutProjection, type InvoiceProjection } from '../src/stripe-provider.js';

const databaseUrl = process.env.BILLING_TEST_DATABASE_URL;
const scope: ProviderScope = { application: 'company', stripeAccountId: 'acct_httpSynthetic', mode: 'test', configVersion: 'http-1' };

test('authenticated HTTP, durable commands and signed webhook recovery against restricted PostgreSQL roles', {
  skip: !databaseUrl && 'BILLING_TEST_DATABASE_URL is absent; real HTTP/database acceptance is not claimed', timeout: 120_000,
}, async t => {
  assert.ok(databaseUrl);
  const base = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)); assert.match(base.pathname, /_test$/);
  const admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
  const roles: string[] = [], pools = {} as StorePools, urls = {} as Record<keyof StorePools, string>;
  let migrated = false;
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    assert.equal((await admin.query("SELECT to_regnamespace('billing') IS NULL AS empty")).rows[0].empty, true);
    assert.equal(await migrate(databaseUrl), 'applied'); migrated = true;
    assert.equal(await migrate(databaseUrl), 'current');
    for (const lane of ['api', 'dispatcher', 'webhook', 'meter'] as const) {
      const name = `billing_http_${lane}_${randomBytes(4).toString('hex')}`, password = randomBytes(24).toString('hex');
      await admin.query(`CREATE ROLE "${name}" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}' IN ROLE "onesa_billing_${lane}"`);
      roles.push(name); const url = new URL(databaseUrl); url.username = name; url.password = password;
      urls[lane] = url.toString(); pools[lane] = new pg.Pool({ connectionString: urls[lane], max: 4, connectionTimeoutMillis: 3000 });
    }
    await verifyStorePoolRoles(pools);
    const { publicKey, privateKey } = await generateKeyPair('EdDSA');
    const dummyKey = ['sk', 'test', 'A'.repeat(32)].join('_'), webhookKey = ['whsec', 'B'.repeat(32)].join('_');
    const config: BillingConfig = {
      scope, host: '127.0.0.1', port: 8099, returnBase: 'https://portal.example.invalid', allowedOrigins: ['https://portal.example.invalid'],
      authIssuer: 'https://issuer.example.invalid', authAudience: 'onesa-billing', authJwks: { keys: [{ ...await exportJWK(publicKey), kid: 'http-test' }] },
      catalog: [{ sku: 'service', title: 'Synthetic service', version: '1', kind: 'one_off', priceId: 'price_httpTest',
        currency: 'eur', unitAmount: 1000, taxBehavior: 'exclusive', maxQuantity: 3 }], catalogFingerprint: 'a'.repeat(64),
      taxEnabled: false, salesEnabled: true, invoiceDaysUntilDue: 14, integrationIdentifier: 'onesa_company_abcdefgh', usageAuthorizations: [],
      secrets: new BillingSecrets(dummyKey, webhookKey, undefined, urls),
    };
    const signer = new Stripe(dummyKey, { apiVersion: STRIPE_API_VERSION });
    const rawVerifier = new StripeCompanyProvider({ scope, secretKey: dummyKey, webhookSecret: webhookKey,
      publicOrigin: config.returnBase, invoiceDaysUntilDue: 14, automaticTaxEnabled: false, integrationIdentifier: config.integrationIdentifier }, signer);
    const customers = new Map<string, CustomerProjection>(), checkouts = new Map<string, CheckoutProjection>(), invoices = new Map<string, InvoiceProjection>();
    let checkoutCalls = 0, invoiceCalls = 0, finalizeCalls = 0, loseCheckoutResponse = false, partialInvoice = false, loseFinalizationResponse = false;
    let customerCalls = 0, loseCustomerResponse = false;
    const own = (op: ProviderOperation) => ({ accountId: op.accountId, commercialIntentId: op.commercialIntentId,
      operationId: op.id, fingerprint: op.fingerprint, origin: 'manual' as const });
    const ref = (prefix: string, op: ProviderOperation) => `${prefix}_${op.id.replaceAll('-', '')}`;
    const invoiceValue = (op: ProviderOperation, customer: CustomerBinding, lines: readonly CatalogLine[]): InvoiceProjection => {
      const total = lines.reduce((sum, line) => sum + line.quantity * line.item.unitAmount, 0);
      return { ...own(op), objectType: 'invoice', id: ref('in', op), customerId: customer.customerId, scope,
        status: 'draft', currency: 'eur', amountDue: total, amountPaid: 0, amountRemaining: total, total,
        subtotal: total, amountShipping: 0, exclusiveTaxTotal: 0, totalTax: 0, adjustmentsPresent: false,
        autoAdvance: false, collectionMethod: 'send_invoice', automaticTaxEnabled: config.taxEnabled,
        automaticTaxStatus: config.taxEnabled ? 'complete' : null,
        hostedInvoiceUrl: null, linesComplete: true, lines: lines.map(line => ({ priceId: line.item.priceId, quantity: line.quantity,
          currency: line.item.currency, amount: line.item.unitAmount * line.quantity, unitAmountDecimal: String(line.item.unitAmount),
          quantityDecimal: String(line.quantity), adjustmentsPresent: false })) };
    };
    const provider: CompanyStripeProvider = {
      scope,
      verifyAccount: async () => ({ stripeAccountId: scope.stripeAccountId, mode: 'test', chargesEnabled: true, detailsSubmitted: true }),
      async ensureCustomer(op, existing) {
        if (existing) return existing;
        customerCalls++;
        const result: CustomerProjection = { ...own(op), accountId: op.accountId, customerId: ref('cus', op), scope, taxLocationStatus: 'unknown' };
        customers.set(result.customerId, result);
        if (loseCustomerResponse) throw new BillingError('stripe_outcome_unknown', 503);
        return result;
      },
      async retrieveCustomer(id) { const found = customers.get(id); assert.ok(found); return structuredClone(found); },
      async createCheckout(op, customer, lines) {
        checkoutCalls++;
        const total = lines.reduce((sum, line) => sum + line.item.unitAmount * line.quantity, 0);
        const result: CheckoutProjection = { ...own(op), objectType: 'checkout.session', id: ref('cs', op), customerId: customer.customerId,
          scope, status: 'open', paymentStatus: 'unpaid', currency: 'eur', amountSubtotal: total, amountTotal: total,
          amountTax: 0, amountDiscount: 0, amountShipping: 0, automaticTaxEnabled: false, automaticTaxStatus: null,
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), hostedUrl: 'https://checkout.stripe.com/c/pay/synthetic', paymentConfirmed: false,
          lines: lines.map(line => ({ priceId: line.item.priceId, quantity: line.quantity, currency: line.item.currency,
            unitAmount: line.item.unitAmount, taxBehavior: line.item.taxBehavior, amountSubtotal: line.item.unitAmount * line.quantity,
            amountTotal: line.item.unitAmount * line.quantity, amountTax: 0, amountDiscount: 0 })) };
        checkouts.set(result.id, result);
        if (loseCheckoutResponse) throw new BillingError('stripe_outcome_unknown', 503);
        return structuredClone(result);
      },
      async retrieveCheckout(id) { const found = checkouts.get(id); assert.ok(found); return structuredClone(found); },
      async createDraftInvoice(op, customer, lines) {
        invoiceCalls++; const result = invoiceValue(op, customer, partialInvoice ? [] : lines); invoices.set(result.id, result);
        if (partialInvoice) throw new BillingError('stripe_outcome_unknown', 503);
        return structuredClone(result);
      },
      async finalizeDraftInvoice(_op, _customer, id) {
        finalizeCalls++; const found = invoices.get(id); assert.ok(found);
        found.status = 'open'; found.hostedInvoiceUrl = 'https://invoice.stripe.com/i/synthetic';
        if (loseFinalizationResponse) throw new BillingError('stripe_outcome_unknown', 503);
        return structuredClone(found);
      },
      async retrieveInvoice(id) { const found = invoices.get(id); assert.ok(found); return structuredClone(found); },
      async createPortal() { throw new BillingError('PORTAL_NOT_CONFIGURED', 503); },
      async taxPreflight() { return { scope, settingsStatus: 'active', headOfficeConfigured: true, defaultTaxCodeConfigured: true,
        defaultTaxBehavior: 'exclusive', activeRegistrationCount: 0, registrationsComplete: true, collectionReadiness: 'not_determined_by_settings' }; },
      parseSignedEvent: (bytes, signature) => rawVerifier.parseSignedEvent(bytes, signature),
      async retrieveVerifiedObject(event) {
        if (event.objectType === 'checkout.session') return this.retrieveCheckout(event.objectId);
        if (event.objectType === 'invoice') return this.retrieveInvoice(event.objectId);
        return this.retrieveCustomer(event.objectId);
      },
    };
    const store = new BillingStore({ scope, pools }), service = new BillingService(config, store, provider);
    app = buildApp(config, service); await app.ready();
    async function token(subject = 'alice', permission = 'billing:account') {
      return new SignJWT({ scope: permission, role: 'owner', account_id: 'untrusted-claim' })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'http-test' }).setIssuer(config.authIssuer).setAudience(config.authAudience)
        .setSubject(subject).setIssuedAt().setExpirationTime('5m').setJti(randomUUID()).sign(privateKey);
    }
    async function request(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, subject = 'alice', key = randomUUID(), permission = 'billing:account') {
      return app!.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${await token(subject, permission)}`,
        origin: config.returnBase, 'idempotency-key': key } });
    }
    async function webhook(type: string, id: string, object: 'invoice' | 'checkout.session' | 'customer', eventId = 'evt_' + randomUUID().replaceAll('-', '')) {
      const raw = JSON.stringify({ object: 'event', id: eventId, type, api_version: STRIPE_API_VERSION,
        created: Math.floor(Date.now() / 1000), livemode: false, data: { object: { id, object } } });
      const signature = signer.webhooks.generateTestHeaderString({ payload: raw, secret: webhookKey });
      const response = await app!.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload: raw,
        headers: { 'content-type': 'application/json', 'stripe-signature': signature } });
      assert.equal(response.statusCode, 200, response.body); return { raw, signature, eventId };
    }
    let accountId: string, customer: CustomerBinding;
    await t.test('auth/origin boundary and server catalog reject forged ownership and amounts', async () => {
      assert.equal((await app!.inject({ method: 'GET', url: '/v1/accounts' })).statusCode, 401);
      assert.equal((await app!.inject({ method: 'GET', url: '/v1/catalog', headers: { authorization: `Bearer ${await token()}`, origin: 'https://other.example.invalid' } })).statusCode, 403);
      const created = await request('POST', '/v1/accounts', { displayName: 'Synthetic account' }); assert.equal(created.statusCode, 201, created.body);
      accountId = created.json().id;
      assert.equal((await request('GET', `/v1/accounts/${accountId}`, undefined, 'mallory')).statusCode, 404);
      assert.equal((await request('POST', `/v1/accounts/${accountId}/intents`, { kind: 'checkout', items: [{ sku: 'service', quantity: 1, amount: 1 }] })).statusCode, 400);
      const result = await request('POST', `/v1/accounts/${accountId}/customer`, {}); assert.equal(result.statusCode, 202, result.body);
      await service.dispatchNext(result.json().id);
      customer = (await store.getCustomer({ issuer: config.authIssuer, subject: 'alice' }, accountId))!; assert.ok(customer);
      assert.equal((await request('GET', `/v1/operations/${result.json().id}`, undefined, 'mallory')).statusCode, 404);
      const history = await request('GET', `/v1/accounts/${accountId}/operations`); assert.equal(history.statusCode, 200);
      for (const field of ['frozenRequest', 'idempotencyKey', 'fingerprint', 'customerId', 'authorization']) assert.equal(history.body.includes(`"${field}"`), false);
    });

    await t.test('lost Checkout response cannot create a replacement charge and signed duplicate events recover it', async () => {
      const intentResponse = await request('POST', `/v1/accounts/${accountId}/intents`, { kind: 'checkout', items: [{ sku: 'service', quantity: 1 }] });
      assert.equal(intentResponse.statusCode, 201, intentResponse.body); const intentId = intentResponse.json().id;
      const command = await request('POST', `/v1/accounts/${accountId}/intents/${intentId}/submit`, {}); assert.equal(command.statusCode, 202, command.body);
      const operationId = command.json().id; loseCheckoutResponse = true; await service.dispatchNext(operationId); loseCheckoutResponse = false;
      assert.equal((await request('GET', `/v1/operations/${operationId}`)).json().state, 'unknown');
      const retry = await request('POST', `/v1/accounts/${accountId}/intents/${intentId}/submit`, {});
      assert.equal(retry.json().id, operationId); assert.equal((await service.dispatchNext(operationId)).processed, false); assert.equal(checkoutCalls, 1);
      const current = [...checkouts.values()][0]; current.status = 'complete'; current.paymentStatus = 'paid'; current.paymentConfirmed = true; current.hostedUrl = null;
      const event = await webhook('checkout.session.completed', current.id, 'checkout.session');
      const duplicate = await app!.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload: event.raw,
        headers: { 'content-type': 'application/json', 'stripe-signature': event.signature } });
      assert.equal(duplicate.statusCode, 200); assert.equal(await service.reconcileNext(), true); assert.equal(await service.reconcileNext(), false);
      const paid = await request('GET', `/v1/operations/${operationId}`); assert.equal(paid.json().state, 'succeeded'); assert.equal(paid.json().paymentConfirmed, true);
      assert.equal(paid.json().amountMinor, 1000); assert.equal(paid.json().redirectUrl, null);
      const changed = await app!.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload: event.raw + ' ',
        headers: { 'content-type': 'application/json', 'stripe-signature': event.signature } });
      assert.equal(changed.statusCode, 400); assert.equal(checkoutCalls, 1);
    });

    await t.test('partial draft webhook cannot complete invoice creation; exact finalized invoice resolves attempted unknown finalization', async () => {
      const intentResponse = await request('POST', `/v1/accounts/${accountId}/intents`, { kind: 'invoice', items: [{ sku: 'service', quantity: 2 }] });
      assert.equal(intentResponse.statusCode, 201); const intentId = intentResponse.json().id;
      const command = await request('POST', `/v1/accounts/${accountId}/intents/${intentId}/submit`, {}); const creationId = command.json().id;
      partialInvoice = true; await service.dispatchNext(creationId); partialInvoice = false;
      const partial = [...invoices.values()][0]; await webhook('invoice.created', partial.id, 'invoice'); await service.reconcileNext();
      assert.equal((await request('GET', `/v1/operations/${creationId}`)).json().state, 'unknown');
      const actor = { issuer: config.authIssuer, subject: 'alice' }, original = await store.getOperation(actor, creationId), intent = await store.getCommercialIntent(actor, accountId, intentId);
      const complete = invoiceValue(original, customer, intent.lines); invoices.set(complete.id, complete);
      await webhook('invoice.updated', complete.id, 'invoice'); await service.reconcileNext();
      assert.equal((await request('GET', `/v1/operations/${creationId}`)).json().state, 'succeeded');
      const finalization = await request('POST', `/v1/accounts/${accountId}/invoices/finalize`, { draftOperationId: creationId });
      assert.equal(finalization.statusCode, 202, finalization.body); loseFinalizationResponse = true; await service.dispatchNext(finalization.json().id); loseFinalizationResponse = false;
      assert.equal((await request('GET', `/v1/operations/${finalization.json().id}`)).json().state, 'unknown');
      await webhook('invoice.finalized', complete.id, 'invoice'); await service.reconcileNext();
      const final = await request('GET', `/v1/operations/${finalization.json().id}`);
      assert.equal(final.json().state, 'succeeded', final.body); assert.equal(final.json().providerState, 'open');
      assert.equal(final.json().paymentConfirmed, false); assert.equal(invoiceCalls, 1); assert.equal(finalizeCalls, 1);
    });

    await t.test('usage is authorized by configured producer mapping and records exact decimal quantities once', async () => {
      const now = Date.now();
      config.usageAuthorizations.push({ actor: { issuer: config.authIssuer, subject: 'trusted-usage-source' }, binding: {
        accountId, scope, stripeCustomerId: customer.customerId, metronomeCustomerId: 'metronome-synthetic', metronomeProjectId: 'project-synthetic',
        environment: 'sandbox', contractId: 'contract-synthetic', meterId: 'api-calls', eventType: 'api_call', quantityKey: 'units', properties: { service: 'synthetic' },
        periodStart: new Date(now - 86_400_000).toISOString(), periodEnd: new Date(now + 86_400_000).toISOString(), ingestUntil: new Date(now + 172_800_000).toISOString(),
      } });
      const event = { sourceEventId: 'synthetic-event-1', meterId: 'api-calls', quantity: '9007199254740993.125', occurredAt: new Date(now - 1000).toISOString() };
      assert.equal((await request('POST', '/v1/usage', event, 'mallory', randomUUID(), 'billing:usage')).statusCode, 403);
      const first = await request('POST', '/v1/usage', event, 'trusted-usage-source', randomUUID(), 'billing:usage'); assert.equal(first.statusCode, 202, first.body);
      const repeated = await request('POST', '/v1/usage', event, 'trusted-usage-source', randomUUID(), 'billing:usage'); assert.equal(repeated.statusCode, 200, repeated.body);
      assert.equal(repeated.json().transactionId, first.json().transactionId);
      const changed = await request('POST', '/v1/usage', { ...event, quantity: '1' }, 'trusted-usage-source', randomUUID(), 'billing:usage'); assert.equal(changed.statusCode, 409);
      assert.equal((await admin.query('SELECT prepared_event->>\'quantity\' AS quantity FROM billing.usage_events WHERE id=$1', [first.json().id])).rows[0].quantity, event.quantity);
      const forged = await request('POST', '/v1/usage', { ...event, customerId: 'cus_forged' }, 'trusted-usage-source', randomUUID(), 'billing:usage'); assert.equal(forged.statusCode, 400);
    });
    await t.test('viewer can read invoice status but only an explicitly granted payer receives its hosted payment capability', async () => {
      const actor = { issuer: config.authIssuer, subject: 'alice' };
      const finalization = (await store.listOperations(actor, accountId)).find(value => value.kind === 'invoice_finalize'); assert.ok(finalization);
      const granted = await request('PATCH', `/v1/accounts/${accountId}/members`, { expectedRevision: 1, subject: 'mallory', role: 'viewer', status: 'active' });
      assert.equal(granted.statusCode, 200, granted.body);
      const reader = await request('GET', `/v1/operations/${finalization.id}`, undefined, 'mallory');
      assert.equal(reader.statusCode, 200); assert.equal(reader.json().providerState, 'open'); assert.equal(reader.json().redirectUrl, null);
      assert.equal((await request('POST', `/v1/accounts/${accountId}/customer`, {}, 'mallory')).statusCode, 403);
      assert.equal((await request('PATCH', `/v1/accounts/${accountId}/members`, { expectedRevision: 2, subject: 'mallory', role: 'payer', status: 'active' })).statusCode, 200);
      const payer = await request('GET', `/v1/operations/${finalization.id}`, undefined, 'mallory');
      assert.equal(payer.statusCode, 200); assert.equal(payer.json().redirectUrl, 'https://invoice.stripe.com/i/synthetic');
    });
    await t.test('operation reads refuse altered frozen Tax switches before returning money or hosted payment capabilities', async () => {
      const actor = { issuer: config.authIssuer, subject: 'alice' };
      for (const projection of [[...checkouts.values()][0], [...invoices.values()][0]]) {
        const saved = structuredClone(projection);
        assert.equal(saved.automaticTaxEnabled, false);
        const operation = (await store.listOperations(actor, accountId)).find(value => value.providerObjectId === projection.id);
        assert.ok(operation);
        try {
          // Keep all frozen amounts, ownership and line identities genuine; only the Tax switch changes.
          projection.automaticTaxEnabled = true; projection.automaticTaxStatus = 'complete';
          const response = await request('GET', `/v1/operations/${operation.id}`);
          assert.equal(response.statusCode, 409);
          assert.deepEqual(response.json(), { error: { code: 'BILLING_TAX_CONFIGURATION_MISMATCH' } });
        } finally { Object.assign(projection, saved); }
        assert.equal((await request('GET', `/v1/operations/${operation.id}`)).statusCode, 200);
      }
    });
    await t.test('invoice history rejects changed automation and original draft ownership before exposing its payment URL', async () => {
      const actor = { issuer: config.authIssuer, subject: 'alice' }, invoice = [...invoices.values()][0];
      const finalization = (await store.listOperations(actor, accountId)).find(value => value.kind === 'invoice_finalize' && value.providerObjectId === invoice.id);
      assert.ok(finalization);
      const changes: { fields: Partial<InvoiceProjection>; code: string }[] = [
        { fields: { autoAdvance: true }, code: 'BILLING_INVOICE_POLICY_MISMATCH' },
        { fields: { collectionMethod: 'charge_automatically' }, code: 'BILLING_INVOICE_POLICY_MISMATCH' },
        { fields: { operationId: randomUUID() }, code: 'BILLING_RESOURCE_OWNERSHIP' },
        { fields: { fingerprint: '0'.repeat(64) }, code: 'BILLING_RESOURCE_OWNERSHIP' },
      ];
      for (const { fields, code } of changes) {
        const saved = structuredClone(invoice);
        try {
          Object.assign(invoice, fields);
          const response = await request('GET', `/v1/operations/${finalization.id}`);
          assert.equal(response.statusCode, 409);
          assert.deepEqual(response.json(), { error: { code } });
        } finally { Object.assign(invoice, saved); }
      }
      const restored = await request('GET', `/v1/operations/${finalization.id}`);
      assert.equal(restored.statusCode, 200); assert.equal(restored.json().redirectUrl, 'https://invoice.stripe.com/i/synthetic');
    });
    await t.test('incomplete automatic tax cannot expose an open payment link or confirm a paid invoice', async () => {
      const previousTax = config.taxEnabled;
      try {
        // A normal authorized intent freezes Tax enabled; this mock provider fixture never calls Stripe.
        config.taxEnabled = true;
        const intentResponse = await request('POST', `/v1/accounts/${accountId}/intents`, { kind: 'invoice', items: [{ sku: 'service', quantity: 1 }] });
        assert.equal(intentResponse.statusCode, 201);
        const command = await request('POST', `/v1/accounts/${accountId}/intents/${intentResponse.json().id}/submit`, {});
        assert.equal(command.statusCode, 202); await service.dispatchNext(command.json().id);
        const created = await request('GET', `/v1/operations/${command.json().id}`);
        assert.equal(created.statusCode, 200); assert.equal(created.json().state, 'succeeded');
        const finalization = await request('POST', `/v1/accounts/${accountId}/invoices/finalize`, { draftOperationId: command.json().id });
        assert.equal(finalization.statusCode, 202); await service.dispatchNext(finalization.json().id);
        const invoice = [...invoices.values()].find(value => value.operationId === command.json().id); assert.ok(invoice);
        assert.equal(invoice.automaticTaxEnabled, true);
        for (const status of ['open', 'paid'] as const) {
          invoice.status = status; invoice.amountPaid = status === 'paid' ? invoice.total : 0;
          invoice.amountRemaining = status === 'paid' ? 0 : invoice.total;
          invoice.automaticTaxStatus = 'requires_location_inputs';
          const response = await request('GET', `/v1/operations/${finalization.json().id}`);
          assert.equal(response.statusCode, 409);
          assert.deepEqual(response.json(), { error: { code: 'BILLING_TAX_INCOMPLETE' } });
        }
        invoice.automaticTaxStatus = 'complete';
        const qualified = await request('GET', `/v1/operations/${finalization.json().id}`);
        assert.equal(qualified.statusCode, 200); assert.equal(qualified.json().paymentConfirmed, true);
        assert.equal(qualified.json().redirectUrl, 'https://invoice.stripe.com/i/synthetic');
      } finally { config.taxEnabled = previousTax; }
    });
    await t.test('customer recovery holds altered commercial-intent metadata and accepts the exact original owner without replaying creation', async () => {
      const actor = { issuer: config.authIssuer, subject: 'alice' }, callsBefore = customerCalls;
      const created = await request('POST', '/v1/accounts', { displayName: 'Synthetic customer recovery' });
      assert.equal(created.statusCode, 201); const recoveryAccountId = created.json().id;
      const command = await request('POST', `/v1/accounts/${recoveryAccountId}/customer`, {});
      assert.equal(command.statusCode, 202);
      try { loseCustomerResponse = true; await service.dispatchNext(command.json().id); }
      finally { loseCustomerResponse = false; }
      const projection = [...customers.values()].find(value => value.operationId === command.json().id); assert.ok(projection);
      const originalIntent = projection.commercialIntentId;
      assert.equal((await request('GET', `/v1/operations/${command.json().id}`)).json().state, 'unknown');
      assert.equal(await store.getCustomer(actor, recoveryAccountId), null);
      try {
        // Operation, account, scope, customer and fingerprint remain genuine; the original intent alone differs.
        projection.commercialIntentId = randomUUID();
        const bad = await webhook('customer.created', projection.customerId, 'customer');
        assert.equal(await service.reconcileNext(), true);
        assert.equal((await request('GET', `/v1/operations/${command.json().id}`)).json().state, 'unknown');
        assert.equal(await store.getCustomer(actor, recoveryAccountId), null);
        const held = (await admin.query('SELECT j.state,j.reason FROM billing.reconciliation_jobs j JOIN billing.webhook_events e ON e.id=j.event_row_id WHERE e.event_id=$1', [bad.eventId])).rows;
        assert.deepEqual(held, [{ state: 'held', reason: 'ownership_mismatch' }]);
      } finally { projection.commercialIntentId = originalIntent; }
      await webhook('customer.updated', projection.customerId, 'customer');
      assert.equal(await service.reconcileNext(), true);
      assert.equal((await request('GET', `/v1/operations/${command.json().id}`)).json().state, 'succeeded');
      assert.equal((await store.getCustomer(actor, recoveryAccountId))?.customerId, projection.customerId);
      assert.equal((await service.dispatchNext(command.json().id)).processed, false);
      assert.equal(customerCalls, callsBefore + 1);
    });
    await t.test('readiness refuses altered migration history through the restricted read connection', async () => {
      await verifyMigration(pools.api);
      const original = (await admin.query('SELECT checksum FROM billing.schema_migrations')).rows[0].checksum;
      await admin.query('UPDATE billing.schema_migrations SET checksum=$1', ['0'.repeat(64)]);
      await assert.rejects(verifyMigration(pools.api), { code: 'MIGRATION_CHECKSUM_MISMATCH' });
      await assert.rejects(migrate(databaseUrl), { code: 'MIGRATION_CHECKSUM_MISMATCH' });
      await admin.query('UPDATE billing.schema_migrations SET checksum=$1', [original]);
      await verifyMigration(pools.api);
    });
  } finally {
    if (app) await app.close();
    for (const pool of Object.values(pools)) await pool.end();
    if (migrated) await admin.query('DROP SCHEMA billing CASCADE');
    for (const role of roles) await admin.query(`DROP ROLE "${role}"`);
    await admin.end();
  }
});
