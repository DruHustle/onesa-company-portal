// Owner-invoked observations of real hosted services. This module issues no authority.
import {createHmac, randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {establishPreviewSession} from './oracle_portal_browser_session.mjs';
import {validateMailbox, waitForDeliveredLink, MailObservationError} from './oracle_portal_identity_mail.mjs';

export const ACCOUNT_CHECKS = Object.freeze([
  'registration_verification_delivery', 'portal_member_access',
  'portal_administrator_access', 'administrator_step_up',
  'member_administrator_denial', 'password_reset_delivery', 'global_session_revocation',
]);
export const PRODUCT_CHECKS = Object.freeze([
  'ai_authenticated_workspace', 'drone_authorized_workspace', 'robot_readonly_simulation',
  'global_administrator_products', 'product_revocation', 'one_product_entitlement',
  'two_product_entitlements', 'access_request_approval',
]);
const PRODUCTS = ['ai', 'drone', 'robot'];
const PRODUCTION = {portal: 'https://portal.onesa.eu', ai: 'https://platform.onesa.eu',
  drone: 'https://drone.onesa.eu', robot: 'https://robot.onesa.eu'};
// Existing Drone owner profile publishes this fixed staging alias. Portal, AI
// and Robot use their independently provider-verified protected Vercel previews.
const STAGING_ALIASES = {drone: 'https://drone-staging.onesa.eu'};
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]{3,189}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const budgets = new WeakMap();

export class ObservationError extends Error {
  constructor(code) { super(code); this.name = 'ObservationError'; }
}
const require = (value, code) => { if (!value) throw new ObservationError(code); };
const keys = (value, expected, code) => require(value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join(',') === [...expected].sort().join(','), code);
function checkpoint(context) {
  const budget = budgets.get(context);
  require(!budget || budget.cleaning || Date.now() < budget.deadline, 'IDENTITY_OBSERVATION_DEADLINE');
}

export function validateRequest(value) {
  keys(value, ['schema_version', 'binding', 'environment', 'operation_id', 'scope', 'origins',
    'preview_sessions', 'fixtures'], 'IDENTITY_REQUEST_SCHEMA');
  require(value.schema_version === 1 && ['account', 'integrated'].includes(value.scope) &&
    ['staging', 'production'].includes(value.environment) && UUID.test(value.operation_id), 'IDENTITY_REQUEST_SCOPE');
  const binding = value.binding;
  require(binding && binding.repository === 'DruHustle/onesa-company-portal' &&
    binding.component === (value.scope === 'account' ? 'identity' : 'identity-acceptance') &&
    /^[a-f0-9]{40}$/.test(binding.candidate_commit) && /^[a-f0-9]{40}$/.test(binding.source_tree), 'IDENTITY_SOURCE_BINDING');
  keys(value.origins, ['portal', ...PRODUCTS], 'IDENTITY_ORIGIN_SCHEMA');
  for (const [product, origin] of Object.entries(value.origins)) {
    let url; try { url = new URL(origin); } catch { throw new ObservationError('IDENTITY_ORIGIN'); }
    require(origin === url.origin && url.protocol === 'https:' && !url.port && !url.username && !url.password &&
      (value.environment === 'production' ? origin === PRODUCTION[product] :
        origin === STAGING_ALIASES[product] || /^onesa-[a-z0-9-]+\.vercel\.app$/.test(url.hostname)), 'IDENTITY_ORIGIN');
  }
  require(new Set(Object.values(value.origins)).size === 4, 'DISTINCT_PRODUCT_ORIGINS');
  require(value.preview_sessions && Object.getPrototypeOf(value.preview_sessions) === Object.prototype &&
    Object.keys(value.preview_sessions).every(key => key in value.origins), 'PREVIEW_SESSION_SCHEMA');
  require(value.environment !== 'production' || Object.keys(value.preview_sessions).length === 0, 'PRODUCTION_PREVIEW_SECRET_REFUSED');
  for (const [product, preview] of Object.entries(value.preview_sessions)) {
    keys(preview, ['origin', 'bypass_secret'], 'PREVIEW_SESSION_SCHEMA');
    require(preview.origin === value.origins[product] && typeof preview.bypass_secret === 'string' &&
      preview.bypass_secret.length >= 16 && preview.bypass_secret.length <= 512 &&
      !/[\s\x00-\x1f\x7f]/.test(preview.bypass_secret), 'PREVIEW_SESSION_BINDING');
  }
  keys(value.fixtures, ['owner', 'member', 'administrator', 'drone_workspace', 'mailbox', 'product_clients'], 'FIXTURE_SCHEMA');
  keys(value.fixtures.product_clients, PRODUCTS, 'FIXTURE_CLIENT_SCHEMA');
  require(Object.values(value.fixtures.product_clients).every(client => typeof client === 'string' &&
    /^[A-Za-z0-9_-]{16,128}$/.test(client)) && new Set(Object.values(value.fixtures.product_clients)).size === 3,
  'FIXTURE_CLIENT_SCHEMA');
  for (const role of ['owner', 'member', 'administrator']) {
    const fixture = value.fixtures[role];
    keys(fixture, role === 'owner' ? ['email', 'password', 'totp_secret'] : ['email', 'password'], 'FIXTURE_ACCOUNT_SCHEMA');
    require(EMAIL.test(fixture.email) && fixture.email === fixture.email.toLowerCase() &&
      typeof fixture.password === 'string' && fixture.password.length >= 14 && fixture.password.length <= 128 &&
      !/[\x00-\x1f\x7f]/.test(fixture.password), 'FIXTURE_ACCOUNT_SCHEMA');
    if (role !== 'owner') require(fixture.email.split('@')[0].includes(
      'onesa-acceptance-' + value.operation_id.slice(0, 8) + '-' + role), 'OPERATION_UNIQUE_SYNTHETIC_ACCOUNT_REQUIRED');
  }
  require(new Set(['owner', 'member', 'administrator'].map(role => value.fixtures[role].email)).size === 3 &&
    /^[A-Z2-7]{32,128}$/.test(value.fixtures.owner.totp_secret), 'DISTINCT_FIXTURE_ACCOUNTS');
  keys(value.fixtures.drone_workspace, ['tenant_id', 'label'], 'FIXTURE_WORKSPACE_SCHEMA');
  require(UUID.test(value.fixtures.drone_workspace.tenant_id) &&
    typeof value.fixtures.drone_workspace.label === 'string' && value.fixtures.drone_workspace.label.length >= 1 &&
    value.fixtures.drone_workspace.label.length <= 100, 'FIXTURE_WORKSPACE_SCHEMA');
  validateMailbox(value.fixtures.mailbox);
  return value;
}

export function totp(secret, step) {
  require(/^[A-Z2-7]{32,128}$/.test(secret) && Number.isSafeInteger(step) && step >= 0, 'MFA_INPUT');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, accumulator = 0;
  const bytes = [];
  for (const character of secret) {
    accumulator = (accumulator << 5) | alphabet.indexOf(character); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((accumulator >>> bits) & 255); }
  }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

// Always wait for a new time step, including the first use of existing owner MFA.
// This preserves the server's single-use check and never retries a failed write.
async function freshCode(secret) {
  const step = Math.floor(Date.now() / 30000) + 1;
  await delay(step * 30000 + 1200 - Date.now());
  return totp(secret, step);
}

async function responseJSON(response, accepted, code) {
  require(accepted.includes(response.status()), code);
  const bytes = await response.body(); require(bytes.length <= 256 * 1024, 'HOSTED_RESPONSE_BOUNDS');
  let result; try { result = JSON.parse(bytes.toString('utf8')); } catch { throw new ObservationError('HOSTED_JSON_REQUIRED'); }
  return result;
}

async function api(context, origin, path, {method = 'GET', body, csrf, status = [200]} = {}) {
  checkpoint(context);
  require(path.startsWith('/api/v1/') && !path.includes('://'), 'HOSTED_API_PATH');
  const response = await context.request.fetch(origin + path, {method, timeout: 20000, maxRedirects: 0,
    headers: {Origin: origin, Accept: 'application/json', ...(csrf ? {'X-CSRF-Token': csrf} : {})},
    ...(body === undefined ? {} : {data: body})});
  return responseJSON(response, status, 'HOSTED_API_STATUS');
}

async function newContext(browser, request, budget) {
  const context = await browser.newContext({locale: 'en-GB', viewport: {width: 1280, height: 900},
    colorScheme: 'light', serviceWorkers: 'block', ignoreHTTPSErrors: false});
  budgets.set(context, budget);
  try {
    // Establish each preview cookie in a separate empty jar. The shared helper
    // clears its jar; using it directly here would erase another product session.
    for (const preview of Object.values(request.preview_sessions)) {
      const isolated = await browser.newContext();
      try {
        await establishPreviewSession(isolated, preview.origin, preview.bypass_secret);
        const cookies = await isolated.cookies(preview.origin);
        require(cookies.length === 1 && cookies[0].name === '_vercel_jwt' && cookies[0].secure &&
          cookies[0].domain.replace(/^\./, '') === new URL(preview.origin).hostname, 'PREVIEW_COOKIE_SCOPE');
        await context.addCookies([{name: cookies[0].name, value: cookies[0].value, url: preview.origin,
          secure: true, httpOnly: true, sameSite: 'Lax'}]);
      } finally { await isolated.close(); }
    }
    return context;
  } catch (error) { await context.close(); throw error; }
}

async function portalLogin(page, request, fixture, expect) {
  checkpoint(page.context());
  require(new URL(page.url()).origin === request.origins.portal, 'CREDENTIAL_ORIGIN');
  await expect(page.locator('input[name="email"]')).toBeVisible();
  await page.locator('input[name="email"]').fill(fixture.email);
  await page.locator('input[name="password"]').fill(fixture.password);
  if (await page.locator('input[name="code"]').isVisible()) {
    require(fixture.totp_secret, 'MFA_FIXTURE_REQUIRED');
    await page.locator('input[name="code"]').fill(await freshCode(fixture.totp_secret));
  }
  checkpoint(page.context());
  await page.getByRole('button', {name: 'Continue', exact: true}).click();
  if (fixture.totp_secret) {
    // An ordinary account login first asks for MFA without creating a session.
    await Promise.race([
      page.locator('input[name="code"]').waitFor({state: 'visible', timeout: 10000}),
      page.getByRole('heading', {name: 'Your applications', exact: true}).waitFor({state: 'visible', timeout: 10000}),
      page.waitForURL(url => url.origin !== request.origins.portal, {timeout: 10000}),
    ]).catch(() => {});
    if (new URL(page.url()).origin === request.origins.portal && await page.locator('input[name="code"]').isVisible() &&
      await page.locator('input[name="code"]').inputValue() === '') {
      await page.locator('input[name="code"]').fill(await freshCode(fixture.totp_secret));
      checkpoint(page.context());
      await page.getByRole('button', {name: 'Continue', exact: true}).click();
    }
  }
}

async function loginAccount(context, request, fixture, expect) {
  const page = await context.newPage();
  await page.goto(request.origins.portal + '/account', {waitUntil: 'domcontentloaded'});
  await portalLogin(page, request, fixture, expect);
  await expect(page.getByRole('heading', {name: 'Your applications', exact: true})).toBeVisible({timeout: 20000});
  const session = await api(context, request.origins.portal, '/api/v1/account/me');
  require(session.account?.email === fixture.email && UUID.test(session.account?.id) &&
    session.account.emailVerified === true && typeof session.csrf === 'string', 'ACCOUNT_PRINCIPAL');
  return {page, session};
}

export function validateOwnerSession(value, fixture) {
  require(value?.user?.email === fixture.email && UUID.test(value.user.id) &&
    value.user.role === 'owner' && value.user.disabled === false &&
    typeof value.csrf === 'string' && /^[a-f0-9]{64}$/.test(value.csrf), 'OWNER_PRINCIPAL_REQUIRED');
  return {user: {id: value.user.id, email: value.user.email, role: value.user.role}, csrf: value.csrf};
}

async function loginOwner(context, request) {
  // The additive migration deliberately preserves existing owner credentials;
  // it does not mark that owner's new identity profile as email-verified. Use
  // the retained password/MFA boundary only to authorize fixture administration.
  // The two synthetic principals must still complete the real new account UI.
  const fixture = request.fixtures.owner;
  const logged = validateOwnerSession(await api(context, request.origins.portal, '/api/v1/auth/login',
    {method: 'POST', body: {email: fixture.email, password: fixture.password,
      code: await freshCode(fixture.totp_secret), rememberBrowser: false}}), fixture);
  const current = validateOwnerSession(await api(context, request.origins.portal, '/api/v1/auth/me'), fixture);
  require(current.user.id === logged.user.id && current.csrf === logged.csrf, 'OWNER_SESSION_CHANGED');
  return current;
}

async function lookup(owner, request, email) {
  const directory = await api(owner, request.origins.portal,
    '/api/v1/admin/identity/accounts?search=' + encodeURIComponent(email));
  require(Array.isArray(directory.items) && directory.items.length <= 50, 'ACCOUNT_DIRECTORY_SCHEMA');
  const exact = directory.items.filter(row => row.account?.email === email);
  require(exact.length <= 1, 'ACCOUNT_IDENTITY_AMBIGUOUS');
  return exact[0] || null;
}

async function register(context, request, fixture, expect, recordOwnership) {
  checkpoint(context);
  const page = await context.newPage();
  await page.goto(request.origins.portal + '/account/register', {waitUntil: 'domcontentloaded'});
  await expect(page.getByRole('heading', {name: 'Create your Onesa account', exact: true})).toBeVisible();
  await page.locator('input[name="name"]').fill('Onesa acceptance ' + request.operation_id.slice(0, 8));
  await page.locator('input[name="email"]').fill(fixture.email);
  for (const name of ['Onesa AI', 'Onesa Drone', 'Onesa Robot']) await page.getByRole('checkbox', {name, exact: true}).check();
  const after = Date.now();
  const sent = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/account/register' && response.request().method() === 'POST');
  await page.getByRole('button', {name: 'Email my verification link', exact: true}).click();
  await responseJSON(await sent, [202], 'REGISTRATION_NOT_ACKNOWLEDGED');
  const link = await waitForDeliveredLink(request.fixtures.mailbox,
    {recipient: fixture.email, after, portal: request.origins.portal, path: '/account/confirm'});
  checkpoint(context);
  await page.goto(link, {waitUntil: 'domcontentloaded'});
  require(new URL(page.url()).origin === request.origins.portal, 'CONFIRMATION_ORIGIN');
  await page.locator('input[name="password"]').fill(fixture.password);
  await page.locator('input[name="confirmPassword"]').fill(fixture.password);
  const confirmed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/account/confirm' && response.request().method() === 'POST');
  await page.getByRole('button', {name: 'Verify your email', exact: true}).click();
  await responseJSON(await confirmed, [200], 'VERIFICATION_NOT_ACKNOWLEDGED');
  // Email-only readback cannot establish ownership after an uncertain/racing
  // confirmation. Require the private operation credential to authenticate the
  // immutable account UUID before permitting any later cleanup mutation.
  const proof = await api(context, request.origins.portal, '/api/v1/account/login',
    {method: 'POST', body: {email: fixture.email, password: fixture.password, code: '', rememberBrowser: false}});
  require(proof.account?.email === fixture.email && UUID.test(proof.account?.id) &&
    proof.account.emailVerified === true && proof.account.globalAdmin === false && proof.account.owner === false &&
    typeof proof.csrf === 'string', 'REGISTRATION_OWNERSHIP_UNPROVEN');
  const owned = {email: proof.account.email, id: proof.account.id};
  recordOwnership(owned); // Retain proven UUID even if the following logout is uncertain.
  await api(context, request.origins.portal, '/api/v1/account/logout', {method: 'POST', body: {}, csrf: proof.csrf});
  await page.close(); return owned;
}

async function enroll(context, request, fixture, expect) {
  checkpoint(context);
  const page = await context.newPage();
  await page.goto(request.origins.portal + '/account/setup-authenticator', {waitUntil: 'domcontentloaded'});
  await page.getByLabel('Email address', {exact: true}).fill(fixture.email);
  await page.getByLabel('Registered password', {exact: true}).fill(fixture.password);
  await page.getByRole('button', {name: 'Start authenticator setup', exact: true}).click();
  const output = page.locator('output'); await expect(output).toBeVisible();
  const secret = (await output.textContent()).trim();
  require(/^[A-Z2-7]{32,128}$/.test(secret), 'MFA_ENROLLMENT_SECRET');
  await page.getByLabel('Six-digit authenticator code', {exact: true}).fill(await freshCode(secret));
  await page.getByRole('button', {name: 'Verify authenticator', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Save your recovery codes', exact: true})).toBeVisible();
  const recovery = await page.getByRole('list', {name: 'One-use recovery codes'}).locator('code').allTextContents();
  require(recovery.length === 8 && recovery.every(code => /^[a-f0-9]{24}$/.test(code)), 'MFA_RECOVERY_CODES');
  // The fixture is disabled at completion. No generated secret or recovery code
  // is retained in screenshots, logs, receipts, storageState or command arguments.
  await page.getByRole('checkbox', {name: 'I have saved my recovery codes securely.'}).check();
  await page.getByRole('button', {name: 'Continue to Onesa sign-in', exact: true}).click();
  await page.close(); return {...fixture, totp_secret: secret};
}

async function stepUp(fixture) { return {password: fixture.password, code: await freshCode(fixture.totp_secret)}; }

async function grant(owner, request, ownerSession, target, product, status) {
  const current = await lookup(owner, request, target.email);
  require(current?.account.id === target.id, 'GRANT_TARGET_CHANGED');
  const role = product === 'ai' ? 'user' : 'viewer';
  await api(owner, request.origins.portal, '/api/v1/admin/identity/accounts/' + target.id + '/products/' + product,
    {method: 'PUT', csrf: ownerSession.csrf, body: {role, status,
      expectedRevision: current.access.find(row => row.product === product)?.revision || 0,
      memberships: product === 'drone' && status === 'active' ? [{...request.fixtures.drone_workspace, role: 'viewer'}] : [],
      stepUp: await stepUp(request.fixtures.owner)}});
}

export function verifyEntitlements(snapshot, expected) {
  require(snapshot?.account && !snapshot.account.globalAdmin && !snapshot.account.portalAccess &&
    Array.isArray(snapshot.access) && Array.isArray(expected) && new Set(expected).size === expected.length &&
    expected.every(product => PRODUCTS.includes(product)), 'MEMBER_ENTITLEMENT_SCOPE');
  const rows = snapshot.access;
  require(rows.length === PRODUCTS.length && new Set(rows.map(row => row.product)).size === PRODUCTS.length &&
    rows.every(row => PRODUCTS.includes(row.product) && ['pending','active','revoked','rejected'].includes(row.status) &&
      row.role === (row.product === 'ai' ? 'user' : 'viewer')) &&
    rows.filter(row => row.status === 'active').map(row => row.product).sort().join(',') === [...expected].sort().join(','),
  'MEMBER_ENTITLEMENT_MISMATCH');
}

async function deniedProductSignIn(context, request, product, expect) {
  const origin = request.origins[product], page = await context.newPage();
  try {
    await page.goto(origin + (product === 'robot' ? '/console' : '/'), {waitUntil: 'domcontentloaded'});
    const startPath = product === 'ai' ? '/api/v1/auth/onesa/start' : '/api/v1/auth/identity/start';
    const started = page.waitForResponse(response => new URL(response.url()).origin === origin &&
      new URL(response.url()).pathname === startPath && response.request().method() === 'POST');
    await page.getByRole('button', {name: 'Continue with Onesa', exact: true}).click();
    const start = await responseJSON(await started, [200], 'PRODUCT_START_NOT_ACKNOWLEDGED');
    authorizationBinding(product === 'ai' ? start.authorize_url : start.authorization_url, request, product);
    await page.waitForURL(url => url.origin === request.origins.portal && url.pathname.startsWith('/account/sign-in/'), {timeout: 120000});
    const continuation = page.getByRole('button', {name: /^Continue as /});
    await expect(continuation).toBeVisible({timeout: 20000});
    const denied = page.waitForResponse(response => new URL(response.url()).origin === request.origins.portal &&
      /^\/api\/v1\/account\/interaction\/[^/]+\/continue$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
    await continuation.click();
    const body = await responseJSON(await denied, [403], 'PRODUCT_DENIAL_NOT_OBSERVED');
    require(body.error?.code === 'PRODUCT_ACCESS_REQUIRED', 'PRODUCT_DENIAL_REASON');
    await expect(page.getByRole('alert')).toContainText('Request access');
    await api(context, origin, '/api/v1/auth/me', {status: [401, 403]});
  } finally { await page.close(); }
}

export function authorizationBinding(raw, request, product) {
  let url; try { url = new URL(raw); } catch { throw new ObservationError('PRODUCT_AUTHORIZATION_URL'); }
  const parameters = url.searchParams;
  const callback = request.origins[product] + (product === 'ai' ? '/api/v1/auth/onesa/callback' : '/api/v1/auth/identity/callback');
  const required = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method'];
  require(url.origin === request.origins.portal && url.pathname === '/api/v1/identity/auth' && !url.hash &&
    !url.username && !url.password && [...parameters.keys()].sort().join(',') === required.sort().join(',') &&
    parameters.get('client_id') === request.fixtures.product_clients[product] && parameters.get('redirect_uri') === callback &&
    parameters.get('response_type') === 'code' && parameters.get('scope').split(' ').sort().join(' ') === 'email onesa openid profile' &&
    parameters.get('code_challenge_method') === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(parameters.get('code_challenge')) &&
    ['state', 'nonce'].every(key => /^[A-Za-z0-9_-]{40,128}$/.test(parameters.get(key))), 'PRODUCT_PKCE_BINDING');
  return {callback, state: parameters.get('state')};
}

export function verifyCallback(raw, binding, portal) {
  let url; try { url = new URL(raw); } catch { throw new ObservationError('PRODUCT_CALLBACK'); }
  const parameters = url.searchParams;
  require(url.origin + url.pathname === binding.callback && !url.hash && !url.username && !url.password &&
    parameters.getAll('state').length === 1 && parameters.get('state') === binding.state &&
    parameters.getAll('code').length === 1 && /^[A-Za-z0-9._~-]{16,2048}$/.test(parameters.get('code')) &&
    [...parameters.keys()].every(key => ['state', 'code', 'iss'].includes(key)) &&
    parameters.getAll('iss').length <= 1 && (!parameters.has('iss') || parameters.get('iss') === portal + '/api/v1/identity'),
  'PRODUCT_CALLBACK_BINDING');
}

async function productSignIn(context, request, product, fixture, expect) {
  checkpoint(context);
  const origin = request.origins[product], page = await context.newPage();
  const principal = await api(context, request.origins.portal, '/api/v1/account/me');
  require(principal.account?.id === fixture.id && principal.account.email === fixture.email, 'PRODUCT_CENTRAL_PRINCIPAL');
  const configPath = product === 'ai' ? '/api/v1/auth/onesa/config' :
    product === 'drone' ? '/api/v1/auth/config' : '/api/v1/auth/identity/config';
  const config = await api(context, origin, configPath);
  require(product === 'drone' ? config.shared_account === true : config.enabled === true, 'PRODUCT_IDENTITY_NOT_ENABLED');
  if (product !== 'drone') require(config.account_url === request.origins.portal + '/account', 'PRODUCT_ISSUER_MISMATCH');
  await page.goto(origin + (product === 'robot' ? '/console' : '/'), {waitUntil: 'domcontentloaded'});
  const callbacks = [];
  const callbackPath = product === 'ai' ? '/api/v1/auth/onesa/callback' : '/api/v1/auth/identity/callback';
  const callbackObserver = resource => {
    const url = new URL(resource.url());
    if (url.origin === origin && url.pathname === callbackPath && callbacks.length < 3) callbacks.push(url.href);
  };
  page.on('request', callbackObserver);
  const startPath = product === 'ai' ? '/api/v1/auth/onesa/start' : '/api/v1/auth/identity/start';
  const startResponse = page.waitForResponse(response => new URL(response.url()).origin === origin &&
    new URL(response.url()).pathname === startPath && response.request().method() === 'POST');
  await page.getByRole('button', {name: 'Continue with Onesa', exact: true}).click();
  const start = await responseJSON(await startResponse, [200], 'PRODUCT_START_NOT_ACKNOWLEDGED');
  const authorization = authorizationBinding(product === 'ai' ? start.authorize_url : start.authorization_url, request, product);
  const deadline = Date.now() + 120000;
  let session;
  while (Date.now() < deadline) {
    const current = new URL(page.url());
    require([origin, request.origins.portal].includes(current.origin), 'PRODUCT_REDIRECT_ORIGIN');
    if (current.origin === request.origins.portal) {
      require(current.pathname.startsWith('/account/sign-in/') || current.pathname.startsWith('/api/v1/identity/'), 'PRODUCT_INTERACTION_PATH');
      const continuation = page.getByRole('button', {name: /^Continue as /});
      if (await continuation.isVisible()) {
        await continuation.click();
        await page.waitForURL(url => url.href !== current.href, {timeout: 20000});
      } else if (await page.locator('input[name="email"]').isVisible()) {
        await portalLogin(page, request, fixture, expect);
        await page.waitForURL(url => url.href !== current.href, {timeout: 20000});
      }
    } else {
      const result = await context.request.get(origin + '/api/v1/auth/me', {maxRedirects: 0, timeout: 15000});
      if (result.status() === 200) { session = await responseJSON(result, [200], 'PRODUCT_SESSION'); break; }
      require([401, 403].includes(result.status()), 'PRODUCT_SESSION_UNAVAILABLE');
    }
    await delay(200);
  }
  page.off('request', callbackObserver);
  require(session, 'PRODUCT_SIGN_IN_NOT_OBSERVED');
  require(callbacks.length === 1, 'EXACT_PRODUCT_CALLBACK_REQUIRED');
  verifyCallback(callbacks[0], authorization, request.origins.portal);
  const confirmed = await api(context, request.origins.portal, '/api/v1/account/me');
  require(confirmed.account?.id === principal.account.id && confirmed.account.email === fixture.email, 'PRODUCT_CENTRAL_PRINCIPAL_CHANGED');
  const administrator = !!fixture.totp_secret;
  if (product === 'ai') {
    require(session.email === fixture.email && session.identity_mode === 'onesa' && session.global_admin === administrator &&
      session.administrator === administrator, 'AI_PRINCIPAL');
    const conversations = await api(context, origin, '/api/v1/conversations');
    require(Array.isArray(conversations.items) && conversations.items.length === 0, 'AI_SYNTHETIC_WORKSPACE');
  } else if (product === 'drone') {
    require(session.email === fixture.email && session.identity_managed === true && session.global_admin === administrator, 'DRONE_PRINCIPAL');
    const workspaces = await api(context, origin, '/api/v1/auth/workspaces');
    const selected = workspaces.workspaces?.find(row => row.id === request.fixtures.drone_workspace.tenant_id);
    require(selected && selected.role === (administrator ? 'admin' : 'viewer'), 'DRONE_WORKSPACE_AUTHORIZATION');
    if (!session.tenant_id) {
      await page.getByLabel('Workspace', {exact: true}).selectOption(selected.id);
      await page.getByRole('button', {name: 'Open workspace', exact: true}).click();
    }
    session = await api(context, origin, '/api/v1/auth/me');
    require(session.tenant_id === selected.id && session.role === (administrator ? 'admin' : 'viewer'), 'DRONE_SELECTED_WORKSPACE');
    await api(context, origin, '/api/v1/operations');
  } else {
    require(session.authentication_method === 'onesa' && session.global_administrator === administrator &&
      session.role === (administrator ? 'administrator' : 'viewer'), 'ROBOT_PRINCIPAL');
    const status = await api(context, origin, '/api/v1/status');
    require(status.mode === 'simulation' && status.physical_actuation === false &&
      status.deployment_environment === request.environment, 'ROBOT_SIMULATION_BOUNDARY');
    await api(context, origin, '/api/v1/missions/catalog');
    await expect(page.locator('#operator')).toBeVisible();
    if (!administrator) await api(context, origin, '/api/v1/admin/physical-operation', {status: [403]});
  }
  return {page, session};
}

async function passwordReset(context, request, fixture, expect) {
  checkpoint(context);
  const anonymous = await context.browser().newContext();
  budgets.set(anonymous, budgets.get(context));
  // Reuse only host-scoped preview cookies, never identity/session cookies.
  for (const cookie of await context.cookies()) if (cookie.name === '_vercel_jwt') await anonymous.addCookies([cookie]);
  try {
    const page = await anonymous.newPage();
    await page.goto(request.origins.portal + '/account/security', {waitUntil: 'domcontentloaded'});
    await page.getByLabel('Email address', {exact: true}).fill(fixture.email);
    const after = Date.now();
    const queued = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/account/password/request' && response.request().method() === 'POST');
    await page.getByRole('button', {name: 'Email password reset link', exact: true}).click();
    await responseJSON(await queued, [202], 'PASSWORD_REQUEST_NOT_ACKNOWLEDGED');
    const link = await waitForDeliveredLink(request.fixtures.mailbox,
      {recipient: fixture.email, after, portal: request.origins.portal, path: '/account/security'});
    checkpoint(context);
    await page.goto(link, {waitUntil: 'domcontentloaded'});
    const password = randomBytes(32).toString('base64url');
    await page.getByLabel('New password (at least 14 characters)', {exact: true}).fill(password);
    await page.getByLabel('Confirm new password', {exact: true}).fill(password);
    const changed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/auth/password/reset' && response.request().method() === 'POST');
    await page.getByRole('button', {name: 'Change Onesa password', exact: true}).click();
    await responseJSON(await changed, [200], 'PASSWORD_RESET_NOT_ACKNOWLEDGED');
    await api(context, request.origins.portal, '/api/v1/account/me', {status: [401]});
    if (request.scope === 'integrated') for (const product of PRODUCTS)
      await api(context, request.origins[product], '/api/v1/auth/me', {status: [401, 403]});
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get('access-link');
    require(/^[a-f0-9]{64}$/.test(token || ''), 'PASSWORD_RESET_TOKEN_FORMAT');
    await api(anonymous, request.origins.portal, '/api/v1/auth/password/reset',
      {method: 'POST', body: {token, password}, status: [400]});
    await api(anonymous, request.origins.portal, '/api/v1/account/login',
      {method: 'POST', body: {email: fixture.email, password: fixture.password, code: ''}, status: [401]});
    // Confirm a real login using the new credential, then end that session too.
    const logged = await loginAccount(anonymous, request, {...fixture, password}, expect);
    await api(anonymous, request.origins.portal, '/api/v1/account/logout',
      {method: 'POST', body: {}, csrf: logged.session.csrf});
  } finally { await anonymous.close(); }
}

export async function observeHostedIdentity(input) {
  const request = validateRequest(input);
  const load = createRequire(new URL('../../onesa-company-portal-frontend/package.json', import.meta.url));
  const {chromium, expect} = load('@playwright/test');
  const browser = await chromium.launch({headless: true});
  // Fail through finally before the hard process watchdog. Existing per-request
  // and inbox deadlines plus six reserved minutes allow bounded MFA/cleanup.
  const budget = {deadline: Date.now() + 14 * 60 * 1000, cleaning: false};
  const checks = {}, contexts = [];
  let owner, ownerSession, failure, cleanup = true;
  const targets = new Map(), registrationAttempted = new Set();
  const observe = async (name, action) => { checkpoint(owner); await action(); checkpoint(owner); checks[name] = true; };
  try {
    owner = await newContext(browser, request, budget); contexts.push(owner);
    ownerSession = await loginOwner(owner, request);
    for (const role of ['member', 'administrator']) require(await lookup(owner, request, request.fixtures[role].email) === null, 'FRESH_SYNTHETIC_ACCOUNT_REQUIRED');
    const member = await newContext(browser, request, budget), administrator = await newContext(browser, request, budget);
    contexts.push(member, administrator);
    await observe('registration_verification_delivery', async () => {
      for (const [role, context] of [['member', member], ['administrator', administrator]]) {
        registrationAttempted.add(role);
        const proven = await register(context, request, request.fixtures[role], expect, value => targets.set(role, value));
        const current = await lookup(owner, request, request.fixtures[role].email);
        require(current && current.account.id === proven.id && current.account.emailVerified &&
          !current.account.globalAdmin && !current.account.owner, 'REGISTERED_FIXTURE_IDENTITY');
      }
    });
    let memberSession;
    await observe('portal_member_access', async () => {
      memberSession = (await loginAccount(member, request, request.fixtures.member, expect)).session;
      require(memberSession.account.id === targets.get('member').id && !memberSession.account.portalAccess &&
        !memberSession.account.globalAdmin, 'MEMBER_ROLE_BOUNDARY');
    });
    await observe('member_administrator_denial', async () => {
      await api(member, request.origins.portal, '/api/v1/admin/identity/accounts', {status: [401, 403]});
      await api(member, request.origins.portal, '/api/v1/admin/content', {status: [401, 403]});
    });
    const adminFixture = await enroll(administrator, request, request.fixtures.administrator, expect);
    await observe('administrator_step_up', async () => {
      const path = '/api/v1/admin/identity/accounts/' + targets.get('administrator').id + '/administrator';
      // A structurally valid request and fresh owner session must still prove MFA.
      await api(owner, request.origins.portal, path, {method: 'PUT', csrf: ownerSession.csrf,
        body: {administrator: true, stepUp: {password: request.fixtures.owner.password,
          code: 'not-a-valid-recovery-code'}}, status: [401, 403]});
      const unchanged = await lookup(owner, request, adminFixture.email);
      require(unchanged && !unchanged.account.globalAdmin, 'STEP_UP_DENIAL_CHANGED_ROLE');
      await api(owner, request.origins.portal, path, {method: 'PUT', csrf: ownerSession.csrf,
        body: {administrator: true, stepUp: await stepUp(request.fixtures.owner)}});
    });
    let adminSession;
    await observe('portal_administrator_access', async () => {
      const logged = await loginAccount(administrator, request, adminFixture, expect); adminSession = logged.session;
      require(adminSession.account.id === targets.get('administrator').id && adminSession.account.globalAdmin &&
        adminSession.account.portalAccess && adminSession.account.mfaEnrolled && !adminSession.account.owner, 'ADMINISTRATOR_PRINCIPAL');
      await expect(logged.page.getByRole('heading', {name: 'Accounts and product access', exact: true})).toBeVisible({timeout: 20000});
      const adminPage = await logged.page.goto(request.origins.portal + '/admin', {waitUntil: 'domcontentloaded'});
      require(adminPage?.ok() && new URL(logged.page.url()).origin === request.origins.portal, 'PORTAL_ADMIN_DOCUMENT');
      await api(administrator, request.origins.portal, '/api/v1/admin/content');
      await api(administrator, request.origins.portal, '/api/v1/admin/identity/accounts?search=' + encodeURIComponent(adminFixture.email));
    });
    if (request.scope === 'integrated') {
      const memberFixture = {...request.fixtures.member, id: targets.get('member').id};
      await grant(owner, request, ownerSession, targets.get('member'), 'ai', 'active');
      await observe('ai_authenticated_workspace', () => productSignIn(member, request, 'ai', memberFixture, expect));
      await observe('one_product_entitlement', async () => {
        verifyEntitlements(await api(member, request.origins.portal, '/api/v1/account/me'), ['ai']);
        await deniedProductSignIn(member, request, 'drone', expect);
        await deniedProductSignIn(member, request, 'robot', expect);
      });
      await grant(owner, request, ownerSession, targets.get('member'), 'drone', 'active');
      await observe('drone_authorized_workspace', () => productSignIn(member, request, 'drone', memberFixture, expect));
      await observe('two_product_entitlements', async () => {
        verifyEntitlements(await api(member, request.origins.portal, '/api/v1/account/me'), ['ai', 'drone']);
        await api(member, request.origins.ai, '/api/v1/auth/me');
        await deniedProductSignIn(member, request, 'robot', expect);
      });
      await grant(owner, request, ownerSession, targets.get('member'), 'robot', 'active');
      verifyEntitlements(await api(member, request.origins.portal, '/api/v1/account/me'), PRODUCTS);
      await observe('robot_readonly_simulation', () => productSignIn(member, request, 'robot', memberFixture, expect));
      await observe('global_administrator_products', async () => {
        for (const product of PRODUCTS) await productSignIn(administrator, request, product, {...adminFixture, id: targets.get('administrator').id}, expect);
      });
      await observe('product_revocation', async () => {
        await grant(owner, request, ownerSession, targets.get('member'), 'robot', 'revoked');
        await api(member, request.origins.robot, '/api/v1/auth/me', {status: [401, 403]});
        await api(member, request.origins.ai, '/api/v1/auth/me');
        await api(member, request.origins.drone, '/api/v1/auth/me');
      });
      await observe('access_request_approval', async () => {
        const page = await member.newPage();
        try {
          await page.goto(request.origins.portal + '/account', {waitUntil: 'domcontentloaded'});
          const card = page.locator('article').filter({has: page.getByRole('heading', {name: 'Onesa Robot', exact: true})});
          const requested = page.waitForResponse(response => new URL(response.url()).origin === request.origins.portal &&
            new URL(response.url()).pathname === '/api/v1/account/products/robot/request' && response.request().method() === 'POST');
          await card.getByRole('button', {name: 'Request access', exact: true}).click();
          const snapshot = await responseJSON(await requested, [200], 'ACCESS_REQUEST_NOT_ACKNOWLEDGED');
          require(snapshot.access?.find(row => row.product === 'robot')?.status === 'pending', 'ACCESS_REQUEST_NOT_PENDING');
        } finally { await page.close(); }
        await grant(owner, request, ownerSession, targets.get('member'), 'robot', 'active');
        verifyEntitlements(await api(member, request.origins.portal, '/api/v1/account/me'), PRODUCTS);
        await productSignIn(member, request, 'robot', memberFixture, expect);
      });
    }
    await observe('password_reset_delivery', () => passwordReset(member, request, request.fixtures.member, expect));
    await observe('global_session_revocation', async () => {
      await api(administrator, request.origins.portal, '/api/v1/account/logout',
        {method: 'POST', body: {}, csrf: adminSession.csrf});
      await api(administrator, request.origins.portal, '/api/v1/account/me', {status: [401]});
      if (request.scope === 'integrated') for (const product of PRODUCTS)
        await api(administrator, request.origins[product], '/api/v1/auth/me', {status: [401, 403]});
    });
  } catch (error) { failure = error; }
  finally {
    budget.cleaning = true;
    if (ownerSession) {
      for (const role of ['member', 'administrator']) {
        if (!registrationAttempted.has(role)) continue;
        try {
          const target = targets.get(role);
          if (!target) {
            // An email match after an uncertain confirmation grants no mutation
            // authority. Preserve it for inspection if ownership was not proven.
            require(await lookup(owner, request, request.fixtures[role].email) === null, 'UNCERTAIN_FIXTURE_OWNERSHIP');
            continue;
          }
          require(target.email === request.fixtures[role].email && UUID.test(target.id) && target.id !== ownerSession.user.id, 'CLEANUP_TARGET');
          const disabled = await api(owner, request.origins.portal, '/api/v1/admin/users/' + target.id,
            {method: 'PATCH', csrf: ownerSession.csrf, body: {role: 'viewer', disabled: true, resetMfa: false,
              stepUp: await stepUp(request.fixtures.owner)}});
          require(disabled.id === target.id && disabled.email === target.email &&
            disabled.disabled === true && disabled.role === 'viewer', 'CLEANUP_NOT_ACKNOWLEDGED');
        } catch { cleanup = false; }
      }
      try { await api(owner, request.origins.portal, '/api/v1/auth/logout',
        {method: 'POST', body: {}, csrf: ownerSession.csrf}); } catch { cleanup = false; }
    }
    for (const context of contexts) await context.close().catch(() => {});
    await browser.close();
  }
  require(cleanup, 'SYNTHETIC_ACCOUNT_CLEANUP_REQUIRES_INSPECTION');
  if (failure) throw failure;
  const expected = [...ACCOUNT_CHECKS, ...(request.scope === 'integrated' ? PRODUCT_CHECKS : [])];
  require(expected.every(check => checks[check] === true) && Object.keys(checks).length === expected.length, 'INCOMPLETE_HOSTED_IDENTITY_OBSERVATION');
  return {schema_version: 1, state: 'HOSTED_IDENTITY_OBSERVED_NOT_AUTHORIZATION', binding: request.binding,
    environment: request.environment, operation_id: request.operation_id, scope: request.scope, checks,
    physical_hardware_authorized: false, physical_operations: 0, synthetic_accounts_only: true,
    fixture_accounts_disabled: true, observed_at: new Date().toISOString()};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    require(process.argv.length === 2, 'IDENTITY_HELPER_STDIN_ONLY');
    let size = 0; const chunks = [];
    for await (const chunk of process.stdin) { size += chunk.length; require(size <= 65536, 'IDENTITY_REQUEST_BOUNDS'); chunks.push(chunk); }
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const deadline = setTimeout(() => { process.stderr.write('HOSTED_IDENTITY_DEADLINE_INSPECT_FIXTURES\n'); process.exit(1); }, 1200000);
    try { process.stdout.write(JSON.stringify(await observeHostedIdentity(request)) + '\n'); }
    finally { clearTimeout(deadline); }
  } catch (error) {
    process.stderr.write((error instanceof ObservationError || error instanceof MailObservationError ? error.message : 'HOSTED_IDENTITY_OBSERVATION_FAILED') + '\n');
    process.exitCode = 1;
  }
}
