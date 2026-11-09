import Fastify, { type FastifyRequest } from 'fastify';
import { createAuthenticator, type AuthenticatedActor } from './auth.js';
import { BillingError, ensure } from './domain.js';
import type { BillingConfig } from './config.js';
import { BillingService } from './service.js';
import { createUsageProducerAuthenticator, prepareUsageEvent } from './usage.js';

function body(value: unknown, names: readonly string[]): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST');
  const record = value as Record<string, unknown>;
  ensure(Object.keys(record).length === names.length && names.every(name => Object.hasOwn(record, name)), 'INVALID_REQUEST');
  return record;
}
function text(value: unknown, max = 200): string {
  ensure(typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value), 'INVALID_REQUEST');
  return value;
}
function clientKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  ensure(typeof key === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key), 'IDEMPOTENCY_KEY_REQUIRED');
  return key;
}
function parameter(request: FastifyRequest, name: string): string { return text((request.params as Record<string, unknown>)[name]); }

export function buildApp(config: BillingConfig, service: BillingService) {
  const app = Fastify({ logger: false, bodyLimit: 65_536, requestTimeout: 30_000, connectionTimeout: 10_000,
    trustProxy: false, ajv: { customOptions: { removeAdditional: false } } });
  const authenticate = createAuthenticator({ issuer: config.authIssuer, audience: config.authAudience, jwks: config.authJwks });
  const identities = new WeakMap<FastifyRequest, AuthenticatedActor>();
  async function identity(request: FastifyRequest, scope = 'billing:account') {
    let verified = identities.get(request);
    if (!verified) { verified = await authenticate(request.headers.authorization); identities.set(request, verified); }
    ensure(verified.scopes.includes(scope), 'BILLING_FORBIDDEN', 403);
    return verified;
  }
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store, max-age=0').header('Pragma', 'no-cache')
      .header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    const origin = request.headers.origin;
    if (origin) {
      ensure(config.allowedOrigins.includes(origin), 'ORIGIN_FORBIDDEN', 403);
      reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const known = error instanceof BillingError;
    // Do not serialize raw Fastify, PostgreSQL, JWT or provider exceptions.
    const frameworkCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const invalidJson = !known && frameworkCode === 'FST_ERR_CTP_INVALID_JSON_BODY';
    const tooLarge = !known && frameworkCode === 'FST_ERR_CTP_BODY_TOO_LARGE';
    reply.code(known ? error.statusCode : invalidJson ? 400 : tooLarge ? 413 : 503)
      .send({ error: { code: known ? error.code : invalidJson ? 'INVALID_JSON' : tooLarge ? 'REQUEST_TOO_LARGE' : 'SERVICE_UNAVAILABLE' } });
  });
  app.options('/*', async (request, reply) => {
    ensure(request.headers.origin && config.allowedOrigins.includes(request.headers.origin), 'ORIGIN_FORBIDDEN', 403);
    return reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS')
      .header('Access-Control-Allow-Headers', 'Authorization,Content-Type,Idempotency-Key').code(204).send();
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/v1/catalog', async request => {
    await identity(request);
    return { mode: config.scope.mode, salesEnabled: config.salesEnabled,
      items: config.catalog.filter(item => item.kind === 'one_off').map(({ sku, title, version, currency, unitAmount, taxBehavior, maxQuantity }) =>
        ({ sku, title, version, currency, unitAmount, taxBehavior, maxQuantity })) };
  });
  app.get('/v1/accounts', async request => service.store.listAccounts((await identity(request)).actor));
  app.post('/v1/accounts', async (request, reply) => {
    const actor = (await identity(request)).actor, input = body(request.body, ['displayName']);
    const created = await service.store.createAccount(actor, { displayName: text(input.displayName) });
    return reply.code(201).send(created);
  });
  app.get('/v1/accounts/:accountId', async request =>
    service.store.getAccountForActor((await identity(request)).actor, parameter(request, 'accountId')));
  app.get('/v1/accounts/:accountId/operations', async request =>
    service.listOperations((await identity(request)).actor, parameter(request, 'accountId')));
  app.patch('/v1/accounts/:accountId/members', async request => {
    const actor = (await identity(request)).actor;
    const input = body(request.body, ['expectedRevision', 'subject', 'role', 'status']);
    ensure(Number.isSafeInteger(input.expectedRevision) && Number(input.expectedRevision) > 0
      && ['owner', 'payer', 'viewer'].includes(String(input.role)) && ['active', 'revoked'].includes(String(input.status)), 'INVALID_MEMBERSHIP');
    const revision = await service.store.setMembership(actor, parameter(request, 'accountId'), Number(input.expectedRevision), {
      actor: { issuer: config.authIssuer, subject: text(input.subject) }, role: input.role as 'owner' | 'payer' | 'viewer',
      status: input.status as 'active' | 'revoked',
    });
    return { revision };
  });
  app.post('/v1/accounts/:accountId/customer', async (request, reply) => {
    body(request.body, []);
    return reply.code(202).send(await service.prepareCustomer((await identity(request)).actor, parameter(request, 'accountId')));
  });
  app.post('/v1/accounts/:accountId/intents', async (request, reply) => {
    const actor = (await identity(request)).actor, input = body(request.body, ['kind', 'items']);
    ensure(input.kind === 'checkout' || input.kind === 'invoice', 'INVALID_INTENT_KIND');
    ensure(Array.isArray(input.items), 'INVALID_ITEMS');
    const result = await service.createIntent(actor, parameter(request, 'accountId'), input.kind, clientKey(request), input.items);
    return reply.code(result.created ? 201 : 200).send({ id: result.intent.id, kind: result.intent.kind,
      accountId: result.intent.accountId, items: result.intent.lines.map(line => ({ sku: line.item.sku, quantity: line.quantity })),
      createdAt: result.intent.createdAt });
  });
  app.post('/v1/accounts/:accountId/intents/:intentId/submit', async (request, reply) => {
    body(request.body, []);
    const operation = await service.submitIntent((await identity(request)).actor, parameter(request, 'accountId'), parameter(request, 'intentId'), clientKey(request));
    return reply.code(202).send(operation);
  });
  app.post('/v1/accounts/:accountId/invoices/finalize', async (request, reply) => {
    const actor = (await identity(request)).actor, input = body(request.body, ['draftOperationId']);
    return reply.code(202).send(await service.finalizeInvoice(actor, parameter(request, 'accountId'), text(input.draftOperationId), clientKey(request)));
  });
  app.post('/v1/accounts/:accountId/portal', async (request, reply) => {
    const actor = (await identity(request)).actor;
    body(request.body, []);
    const accountId = parameter(request, 'accountId'), key = clientKey(request);
    const { intent } = await service.createIntent(actor, accountId, 'portal', key, []);
    const command = await service.submitIntent(actor, accountId, intent.id, key);
    const dispatched = await service.dispatchNext(command.id);
    if (dispatched.redirectUrl) return { redirectUrl: dispatched.redirectUrl };
    return reply.code(202).send({ ...command, redirectUrl: null });
  });
  app.get('/v1/operations/:operationId', async request =>
    service.getOperation((await identity(request)).actor, parameter(request, 'operationId')));

  app.post('/v1/usage', async (request, reply) => {
    const verified = await identity(request, 'billing:usage');
    const input = body(request.body, ['sourceEventId', 'meterId', 'quantity', 'occurredAt']);
    const authorized = config.usageAuthorizations.find(entry => entry.actor.issuer === verified.actor.issuer
      && entry.actor.subject === verified.actor.subject && entry.binding.meterId === input.meterId);
    ensure(authorized, 'USAGE_PRODUCER_FORBIDDEN', 403);
    // The grant is minted from verified identity plus operator-owned mapping, never body claims or JWT roles.
    const authenticateProducer = createUsageProducerAuthenticator(async () => ({ actor: verified.actor,
      accountId: authorized.binding.accountId, scope: config.scope, allowedMeterIds: [authorized.binding.meterId], expiresAt: verified.expiresAt }));
    const principal = await authenticateProducer(request.headers.authorization!);
    const event = prepareUsageEvent(input, principal, authorized.binding, new Date());
    const result = await service.store.enqueueUsage(event);
    return reply.code(result.created ? 202 : 200).send({ id: result.eventId, transactionId: event.transactionId, status: 'recorded' });
  });
  // Encapsulation preserves exact raw bytes for this endpoint only.
  app.register(async webhooks => {
    webhooks.removeContentTypeParser('application/json');
    webhooks.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 262_144 }, (_request, bytes, done) => done(null, bytes));
    webhooks.post('/v1/webhooks/stripe', { bodyLimit: 262_144 }, async (request, reply) => {
      ensure(Buffer.isBuffer(request.body) && typeof request.headers['stripe-signature'] === 'string', 'WEBHOOK_INVALID', 400);
      const verified = service.provider.parseSignedEvent(request.body, request.headers['stripe-signature']);
      if (verified) await service.store.acceptWebhook(verified);
      return reply.code(200).send({ received: true });
    });
  });
  return app;
}
