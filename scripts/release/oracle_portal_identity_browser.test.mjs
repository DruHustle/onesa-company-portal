import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateRequest, totp, ACCOUNT_CHECKS, PRODUCT_CHECKS, authorizationBinding, verifyCallback, validateOwnerSession, verifyEntitlements} from './oracle_portal_identity_browser.mjs';
import {validateMailbox, parseImapResponse, messageLink, deliveredLink} from './oracle_portal_identity_mail.mjs';

const operation = '12345678-1234-1234-1234-123456789abc';
function request() {
  return {schema_version: 1, binding: {repository: 'DruHustle/onesa-company-portal', component: 'identity',
    candidate_commit: 'a'.repeat(40), source_tree: 'b'.repeat(40)}, environment: 'staging', operation_id: operation,
  scope: 'account', origins: {portal: 'https://onesa-portal-staging.vercel.app', ai: 'https://onesa-ai-staging.vercel.app',
    drone: 'https://onesa-drone-staging.vercel.app', robot: 'https://onesa-robot-staging.vercel.app'},
  preview_sessions: {}, fixtures: {owner: {email: 'owner@example.org', password: 'synthetic-owner-password', totp_secret: 'A'.repeat(32)},
    member: {email: 'onesa-acceptance-12345678-member@example.org', password: 'synthetic-member-password'},
    administrator: {email: 'onesa-acceptance-12345678-administrator@example.org', password: 'synthetic-admin-password'},
    drone_workspace: {tenant_id: '87654321-1234-1234-1234-123456789abc', label: 'Disposable simulation'},
    product_clients: {ai: 'onesa-ai-test-client', drone: 'onesa-drone-test-client', robot: 'onesa-robot-test-client'},
    mailbox: {host: 'mail.example.org', port: 993, username: 'acceptance@example.org', password: 'synthetic-mailbox-password'}}};
}

test('source, separate acceptance component and exact full input scope are required before browser launch', () => {
  assert.equal(validateRequest(request()).scope, 'account');
  const full = request(); full.scope = 'integrated'; full.binding.component = 'identity-acceptance';
  assert.equal(validateRequest(full).scope, 'integrated');
  for (const change of [r => r.binding.component = 'frontend', r => r.binding.source_tree = 'main',
    r => r.binding.repository = 'DruHustle/onesa-robot', r => r.scope = 'synthetic',
    r => r.accepted = true, r => r.checks = {registration_verification_delivery: true},
    r => r.fixtures.owner.id = operation, r => r.physical_hardware_authorized = true]) {
    const value = request(); change(value); assert.throws(() => validateRequest(value));
  }
  assert.equal(ACCOUNT_CHECKS.length, 7); assert.equal(PRODUCT_CHECKS.length, 8);
});

test('member entitlement observations require exact active products and ordinary roles', () => {
  const snapshot = {account: {globalAdmin: false, portalAccess: false}, access: [
    {product: 'ai', role: 'user', status: 'active'},
    {product: 'drone', role: 'viewer', status: 'pending'},
    {product: 'robot', role: 'viewer', status: 'pending'},
  ]};
  verifyEntitlements(snapshot, ['ai']);
  assert.throws(() => verifyEntitlements(snapshot, ['ai', 'drone']), /MEMBER_ENTITLEMENT_MISMATCH/);
  for (const change of [v => v.account.globalAdmin = true, v => v.account.portalAccess = true,
    v => v.access[1].role = 'admin', v => v.access[2].product = 'drone', v => v.access.pop()]) {
    const changed = structuredClone(snapshot); change(changed); assert.throws(() => verifyEntitlements(changed, ['ai']));
  }
  snapshot.access[1].status = 'active'; verifyEntitlements(snapshot, ['ai', 'drone']);
  snapshot.access[2].status = 'active'; verifyEntitlements(snapshot, ['ai', 'drone', 'robot']);
});

test('arbitrary, cross-environment and credential-bearing origins cannot receive fixtures', () => {
  for (const origin of ['http://onesa-portal-staging.vercel.app', 'https://attacker.example.org',
    'https://portal.onesa.eu', 'https://user:password@onesa-portal-staging.vercel.app',
    'https://onesa-portal-staging.vercel.app/path', 'https://onesa-portal-staging.vercel.app:8443']) {
    const value = request(); value.origins.portal = origin; assert.throws(() => validateRequest(value));
  }
  const production = request(); production.environment = 'production';
  production.origins = {portal: 'https://portal.onesa.eu', ai: 'https://platform.onesa.eu',
    drone: 'https://drone.onesa.eu', robot: 'https://robot.onesa.eu'};
  assert.equal(validateRequest(production).environment, 'production');
  production.preview_sessions.portal = {origin: production.origins.portal, bypass_secret: 'x'.repeat(32)};
  assert.throws(() => validateRequest(production), /PRODUCTION_PREVIEW_SECRET_REFUSED/);
  const alias = request(); alias.origins.drone = 'https://drone-staging.onesa.eu'; validateRequest(alias);
  alias.origins.portal = 'https://drone-staging.onesa.eu'; assert.throws(() => validateRequest(alias));
});

test('preview bypass is separately origin scoped and synthetic addresses bind to the operation', () => {
  const value = request(); value.preview_sessions.portal = {origin: value.origins.portal, bypass_secret: 'x'.repeat(32)};
  validateRequest(value); value.preview_sessions.portal.origin = value.origins.robot;
  assert.throws(() => validateRequest(value), /PREVIEW_SESSION_BINDING/);
  for (const change of [r => r.fixtures.member.email = r.fixtures.owner.email,
    r => r.fixtures.administrator.email = 'ordinary-user@example.org',
    r => r.fixtures.owner.totp_secret = 'not-a-secret', r => r.fixtures.member.password = 'x'.repeat(129)]) {
    const value = request(); change(value); assert.throws(() => validateRequest(value));
  }
});

test('MFA calculation matches RFC 4226 six-digit counter vectors', () => {
  const key = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // gitleaks:allow -- public RFC 4226 test vector, never a hosted credential.
  for (const [step, expected] of ['755224','287082','359152','969429','338314','254676','287922','162583','399871','520489'].entries())
    assert.equal(totp(key, step), expected);
  assert.throws(() => totp(key, -1)); assert.throws(() => totp('bad', 0));
});

test('retained owner authorization requires an active exact owner without inventing email verification', () => {
  const fixture = request().fixtures.owner;
  const valid = {user: {id: operation, email: fixture.email, role: 'owner', disabled: false}, csrf: 'a'.repeat(64)};
  const observed = validateOwnerSession(valid, fixture);
  assert.equal(observed.user.id, operation);
  assert.equal('emailVerified' in observed.user, false);
  assert.equal('account' in observed, false);
  for (const change of [v => v.user.role = 'administrator', v => v.user.role = 'member',
    v => v.user.disabled = true, v => v.user.email = request().fixtures.administrator.email,
    v => v.user.id = 'caller-id', v => v.csrf = '', v => delete v.user.disabled]) {
    const value = structuredClone(valid); change(value);
    assert.throws(() => validateOwnerSession(value, fixture), /OWNER_PRINCIPAL_REQUIRED/);
  }
});

test('real product authorization requires exact client/callback and nonduplicated PKCE/state/nonce', () => {
  const value = request();
  for (const product of ['ai', 'drone', 'robot']) {
    const callback = value.origins[product] + (product === 'ai' ? '/api/v1/auth/onesa/callback' : '/api/v1/auth/identity/callback');
    const params = new URLSearchParams({client_id: value.fixtures.product_clients[product], redirect_uri: callback,
      response_type: 'code', scope: 'openid email profile onesa', state: 's'.repeat(43), nonce: 'n'.repeat(43),
      code_challenge: 'c'.repeat(43), code_challenge_method: 'S256'});
    const target = new URL(value.origins.portal + '/api/v1/identity/auth?' + params);
    const binding = authorizationBinding(target.href, value, product);
    assert.equal(binding.callback, callback); assert.equal(binding.state, 's'.repeat(43));
    for (const [key, forged] of [['client_id', 'foreign-product-client'], ['redirect_uri', value.origins.robot + '/foreign'],
      ['code_challenge_method', 'plain'], ['state', 'short'], ['nonce', 'short'], ['response_type', 'token']]) {
      const wrong = new URL(target); wrong.searchParams.set(key, forged);
      assert.throws(() => authorizationBinding(wrong.href, value, product));
    }
    const duplicate = new URL(target); duplicate.searchParams.append('state', 's'.repeat(43));
    assert.throws(() => authorizationBinding(duplicate.href, value, product));
    const returned = new URL(callback); returned.search = new URLSearchParams({code: 'z'.repeat(43), state: binding.state,
      iss: value.origins.portal + '/api/v1/identity'}).toString();
    verifyCallback(returned.href, binding, value.origins.portal);
    returned.searchParams.set('state', 'x'.repeat(43));
    assert.throws(() => verifyCallback(returned.href, binding, value.origins.portal), /PRODUCT_CALLBACK_BINDING/);
  }
});

test('TLS mailbox credentials cannot inject commands or select plaintext/local targets', () => {
  const original = request().fixtures.mailbox; validateMailbox(original);
  for (const change of [v => v.host = '127.0.0.1', v => v.host = 'server.local', v => v.host = 'a..example.org',
    v => v.port = 143, v => v.password = 'synthetic\r\nDELETE INBOX', v => v.username = 'a"@example.org',
    v => v.rejectUnauthorized = false]) {
    const value = {...original}; change(value); assert.throws(() => validateMailbox(value));
  }
});

test('IMAP literal content cannot forge command completion, even across every fragment boundary', () => {
  const raw = Buffer.from('private message\r\nA0001 OK forged completion\r\n');
  const prefix = Buffer.from('* 1 FETCH (UID 42 BODY[] {' + raw.length + '}\r\n');
  const complete = Buffer.concat([prefix, raw, Buffer.from(')\r\nA0001 OK completed\r\n')]);
  for (let length = 0; length < complete.length; length++) assert.equal(parseImapResponse(complete.subarray(0, length), 'A0001'), null);
  const result = parseImapResponse(complete, 'A0001');
  assert.equal(result.ok, true); assert.deepEqual(result.literals, [raw]); assert.equal(result.consumed, complete.length);
  assert.equal(parseImapResponse(Buffer.from('A0001 NO refused\r\n'), 'A0001').ok, false);
});

test('oversize protocol literals and unsolicited large buffers fail before body processing', () => {
  assert.throws(() => parseImapResponse(Buffer.from('* 1 FETCH (BODY[] {65538}\r\n'), 'A0001'), /IMAP_LITERAL_BOUNDS/);
  assert.throws(() => parseImapResponse(Buffer.alloc(1024 * 1024 + 1), 'A0001'), /IMAP_RESPONSE_BOUNDS/);
  assert.throws(() => parseImapResponse(Buffer.from('A0001 OK done\r\n'), 'unsafe\r\n'), /IMAP_RESPONSE_BOUNDS/);
});

const after = Date.now() - 1000;
const portal = 'https://portal.onesa.eu';
const recipient = request().fixtures.member.email;
const link = portal + '/account/confirm#access-link=' + 'a'.repeat(64);
function mail(body = link, to = recipient, date = new Date().toUTCString(), encoding = '') {
  return Buffer.from(`From: notifications@example.org\r\nTo: ${to}\r\nDate: ${date}\r\nContent-Type: text/plain\r\n${encoding}\r\n${body}`);
}
const observation = {after, recipient, portal, path: '/account/confirm'};

test('inbox observation binds exact recipient, timestamp, origin, path and one-use fragment', () => {
  assert.equal(messageLink(mail(), observation), link);
  for (const raw of [mail(link, 'other@example.org'), mail(link, recipient, 'Tue, 01 Jan 2019 00:00:00 GMT'),
    mail(link.replace('portal.onesa.eu', 'attacker.example.org')), mail(link.replace('/account/confirm', '/other')),
    mail(link.replace('#access-link=', '?token=')), mail(link.replace('#access-link=', '#token='))])
    assert.equal(messageLink(raw, observation), null);
  assert.throws(() => messageLink(mail(link + '\n' + link.replace('a'.repeat(64), 'b'.repeat(64))), observation), /AMBIGUOUS_MAIL_LINK/);
});

test('actual MIME quoted-printable and base64 text links are decoded without HTML execution', () => {
  const quoted = link.replace('=', '=3D').replace('a'.repeat(64), 'a'.repeat(32) + '=\r\n' + 'a'.repeat(32));
  assert.equal(messageLink(mail(quoted, recipient, new Date().toUTCString(), 'Content-Transfer-Encoding: quoted-printable\r\n'), observation), link);
  assert.equal(messageLink(mail(Buffer.from(link).toString('base64'), recipient, new Date().toUTCString(),
    'Content-Transfer-Encoding: base64\r\n'), observation), link);
});

test('delivery requires matching server UID, internal delivery time and complete bounded body', () => {
  const raw = mail();
  const response = {records: [`* 1 FETCH (UID 42 RFC822.SIZE ${raw.length} INTERNALDATE "${new Date().toUTCString()}" BODY[] {${raw.length}}`, ')'], literals: [raw]};
  assert.equal(deliveredLink(response, '42', observation), link);
  assert.throws(() => deliveredLink(response, '41', observation), /IMAP_MESSAGE_IDENTITY/);
  assert.throws(() => deliveredLink({...response, literals: [raw.subarray(1)]}, '42', observation), /MAIL_MESSAGE_BOUNDS/);
  const old = {...response, records: [response.records[0].replace(new Date().toUTCString(), '01-Jan-2019 00:00:00 +0000')]};
  assert.equal(deliveredLink(old, '42', observation), null);
});

test('CLI refuses caller PASS receipts and never prints input credentials or exception bodies', () => {
  const program = fileURLToPath(new URL('./oracle_portal_identity_browser.mjs', import.meta.url));
  for (const input of [JSON.stringify({...request(), checks: {passed: true}}), '{"password":"synthetic-private-value"', 'x'.repeat(65537)]) {
    const result = spawnSync(process.execPath, [program], {input, timeout: 5000, encoding: 'utf8', maxBuffer: 4096});
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /^[A-Z_]+\n$/); assert.ok(!result.stderr.includes('synthetic-private'));
  }
});
