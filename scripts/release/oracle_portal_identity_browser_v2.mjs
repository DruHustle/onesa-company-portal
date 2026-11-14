// Read-only, owner-invoked sign-in observations; private request enters via stdin.
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {isProductSignIn, productSignInLabel, totp, verifyCallback} from './oracle_portal_identity_browser.mjs';
import {establishPreviewSession} from './oracle_portal_browser_session.mjs';

const common = {entry: '/', session: '/api/v1/auth/me'};
export const PRODUCTS = Object.freeze({
  ai: {...common, label: productSignInLabel('ai'), callback: '/api/v1/auth/onesa/callback', config: '/api/v1/auth/onesa/config', start: '/api/v1/auth/onesa/start'},
  drone: {...common, label: productSignInLabel('drone'), callback: '/api/v1/auth/identity/callback', config: '/api/v1/auth/config', start: '/api/v1/auth/identity/start'},
  robot: {...common, label: productSignInLabel('robot'), entry: '/console', callback: '/api/v1/auth/identity/callback', config: '/api/v1/auth/identity/config', start: '/api/v1/auth/identity/start'},
  farmer: {entry: '/', label: /^(Pinda neOnesa|Ngena nge-Onesa)$/, session: '/v1/me', config: '/v1/onesa/config', callback: '/auth/onesa/callback', complete: '/v1/onesa/sessions'},
  logistics: {entry: '/#/login?mode=live', label: 'Sign in with Onesa', session: '/api/auth/me', config: '/api/auth/onesa/config', start: '/api/auth/onesa/start', callback: '/api/auth/onesa/callback'},
  pasofi: {entry: '/#staff', label: 'Sign in with Onesa', session: '/api/staff/session', config: '/api/staff/onesa/availability', start: '/api/staff/onesa/start', callback: '/onesa-callback.html', complete: '/api/staff/onesa/complete', mfa: true},
  mobile: {entry: '/internal/', label: 'Continue with Onesa', role: 'link', session: '/api/v1/session', start: '/api/v1/auth/onesa/start', callback: '/api/v1/auth/onesa/callback', mfa: true},
});
const production = {portal:'https://portal.onesa.eu', ai:'https://platform.onesa.eu', drone:'https://drone.onesa.eu',
  robot:'https://robot.onesa.eu', farmer:'https://farmer.onesa.eu', logistics:'https://logistics.onesa.eu',
  pasofi:'https://pasofi.mobile.onesa.eu', mobile:'https://mobile.onesa.eu'};
const vercelProjects = {portal:'onesa-company-portal', ai:'onesa-ai-platform', drone:'onesa-drone',
  robot:'onesa-ai-robot', farmer:'smart-farmer', logistics:'smart-logistics', pasofi:'pasofi', mobile:'onesa-mobile'};
function ownerHosted(app, hostname) {
  const project = vercelProjects[app];
  const ownerAlias = hostname.endsWith('.onesa.eu') && (app !== 'portal' ||
    ['portal-staging.onesa.eu', 'staging.portal.onesa.eu', 'portal.staging.onesa.eu'].includes(hostname));
  return ownerAlias ||
    new RegExp('^' + project + '-[a-z0-9-]+-druhustles-projects\\.vercel\\.app$').test(hostname);
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const UID = '[A-Za-z0-9_-]{8,128}';
const isAccountEntry = url => url.pathname === '/account' && !url.search && !url.hash;
const interactionRead = new RegExp('^/api/v1/account/interaction/' + UID + '$');
const interactionWrite = new RegExp('^/api/v1/account/interaction/' + UID + '/(continue|login)$');
const resume = new RegExp('^/api/v1/identity/auth/' + UID + '$');
const authorize = '/api/v1/identity/auth';
class Failure extends Error {}
const check = (test, code) => { if (!test) throw new Failure(code); };
const keys = (obj, names) => obj && Object.getPrototypeOf(obj) === Object.prototype &&
  Object.keys(obj).sort().join(',') === [...names].sort().join(',');
const matches = (value, re) => typeof value === 'string' && re.test(value);

export function validateRequest(r) {
  check(keys(r, ['schema_version','binding','environment','operation_id','scope','origins','preview_sessions','fixtures']) &&
    r.schema_version === 2 && ['account','integrated'].includes(r.scope) &&
    ['staging','production'].includes(r.environment) && matches(r.operation_id,UUID), 'REQUEST_SCHEMA');
  const b = r.binding, canonical = b?.repository === 'DruHustle/onesa-ug';
  const fields = ['repository','component','candidate_commit','source_tree','source_sha256','build_sha256','artifact_digest','configuration_sha256','target_environment'];
  const provenance = ['schema_version','repository_id','product','source_path','product_source_tree','branch'];
  const sha40 = /^[a-f0-9]{40}$/, sha64 = /^[a-f0-9]{64}$/;
  check(keys(b, canonical ? [...fields,...provenance] : fields) &&
    (canonical ? b.schema_version === 2 && b.repository_id === 1444746154 && b.product === 'portal' &&
      b.source_path === 'onesa-company-portal' && b.branch === 'main' && matches(b.product_source_tree,sha40) :
      b.repository === 'DruHustle/onesa-company-portal') &&
    b.component === (r.scope === 'account' ? 'identity' : 'identity-acceptance') &&
    b.target_environment === 'production' && matches(b.candidate_commit,sha40) && matches(b.source_tree,sha40) &&
    matches(b.source_sha256,sha64) && matches(b.build_sha256,sha64) && matches(b.artifact_digest,/^sha256:[a-f0-9]{64}$/) &&
    keys(b.configuration_sha256,['staging','production']) && Object.values(b.configuration_sha256).every(v=>matches(v,sha64)), 'SOURCE_BINDING');
  check(keys(r.origins,Object.keys(production)) && new Set(Object.values(r.origins)).size === 8, 'ORIGIN_SET');
  for (const [app,origin] of Object.entries(r.origins)) {
    let u; try { u = new URL(origin); } catch { throw new Failure('ORIGIN'); }
    // The owner-pinned plan identifies every relying party. Retain the existing
    // hosted allowlist on the four established clients before sending credentials.
    const legacy = ['portal','ai','drone','robot'].includes(app);
    const legacyStaging = /^onesa-[a-z0-9-]+\.vercel\.app$/.test(u.hostname) ||
      app === 'drone' && origin === 'https://drone-staging.onesa.eu';
    check(origin === u.origin && u.protocol === 'https:' && !u.port && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(u.hostname) &&
      (r.environment === 'production' ? origin === production[app] : !Object.values(production).includes(origin) &&
        (!legacy || legacyStaging || u.hostname.endsWith('.onesa.eu')) &&
        (app !== 'portal' || ownerHosted('portal', u.hostname))), 'ORIGIN');
  }
  const previews = r.preview_sessions;
  check(previews && Object.getPrototypeOf(previews) === Object.prototype &&
    (r.environment === 'staging' || Object.keys(previews).length === 0), 'PREVIEW_SCOPE');
  for (const [app,preview] of Object.entries(previews)) check(Object.hasOwn(r.origins,app) &&
    keys(preview,['origin','bypass_secret']) && preview.origin === r.origins[app] &&
    ownerHosted(app, new URL(preview.origin).hostname) &&
    matches(preview.bypass_secret,/^[^\s\x00-\x1f\x7f]{16,512}$/), 'PREVIEW_BINDING');
  const f = r.fixtures;
  check(keys(f,['owner','drone_workspace','product_clients']) && keys(f.product_clients,Object.keys(PRODUCTS)) &&
    Object.values(f.product_clients).every(v=>matches(v,/^[A-Za-z0-9_-]{16,128}$/)) &&
    new Set(Object.values(f.product_clients)).size === 7, 'FIXTURE_CLIENTS');
  const o = f.owner;
  check(keys(o,['email','password','totp_secret']) && matches(o.email,/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9.-]{3,189}$/) &&
    matches(o.password,/^[^\x00-\x1f\x7f]{14,128}$/) && matches(o.totp_secret,/^[A-Z2-7]{32,128}$/), 'FIXTURE_ADMINISTRATOR');
  check(keys(f.drone_workspace,['tenant_id','label']) && matches(f.drone_workspace.tenant_id,UUID) &&
    matches(f.drone_workspace.label,/^[^\x00-\x1f\x7f]{1,100}$/), 'FIXTURE_WORKSPACE');
  return r;
}

export function authorizationBinding(raw,r,product) {
  const u = new URL(raw), p = u.searchParams, app = PRODUCTS[product];
  const callback = r.origins[product] + app.callback;
  const names = ['client_id','redirect_uri','response_type','scope','state','nonce','code_challenge','code_challenge_method'];
  if (app.mfa) names.push('max_age','acr_values');
  check(u.origin === r.origins.portal && !u.username && !u.password && u.pathname === authorize && !u.hash &&
    [...p.keys()].sort().join(',') === names.sort().join(',') && p.get('client_id') === r.fixtures.product_clients[product] &&
    p.get('redirect_uri') === callback && p.get('response_type') === 'code' &&
    p.get('scope').split(' ').sort().join(' ') === 'email onesa openid profile' &&
    p.get('code_challenge_method') === 'S256' && matches(p.get('code_challenge'),/^[A-Za-z0-9_-]{43}$/) &&
    ['state','nonce'].every(k=>matches(p.get(k),/^[A-Za-z0-9_-]{40,128}$/)) &&
    (!app.mfa || p.get('max_age') === '300' && p.get('acr_values') === 'urn:onesa:mfa'), 'PRODUCT_AUTHORIZATION_BINDING');
  return {callback,state:p.get('state'),nonce:p.get('nonce')};
}

export function portalPrincipal(session, owner, previous) {
  const a = session?.account;
  check(a?.email === owner.email && matches(a.id,UUID) && (!previous || a.id === previous.id) &&
    a.globalAdmin === true && a.portalAccess === true && a.emailVerified === true && a.mfaEnrolled === true, 'PORTAL_ADMINISTRATOR');
  return {id:a.id,email:a.email};
}

export function validateProduct(product,session,principal,detail,request) {
  const s = session, email = principal.email, id = principal.id;
  switch (product) {
    case 'ai':
      check(s.email === email && s.identity_mode === 'onesa' && s.global_admin === true && s.administrator === true, 'AI_ADMINISTRATOR'); break;
    case 'drone':
      check(s.email === email && s.identity_managed === true && s.global_admin === true &&
        detail.workspaces?.some(w=>w.id === request.fixtures.drone_workspace.tenant_id && w.role === 'admin'), 'DRONE_ADMINISTRATOR'); break;
    case 'robot':
      check(s.authentication_method === 'onesa' && s.global_administrator === true && s.role === 'administrator' &&
        detail.mode === 'simulation' && detail.physical_actuation === false && detail.deployment_environment === request.environment, 'ROBOT_ADMINISTRATOR'); break;
    case 'mobile':
      check(s.authenticated === true && s.mode === 'production' && s.authMode === 'onesa' && s.ssoAvailable === true &&
        s.user?.subject === id && s.user.role === 'admin' && s.user.source === 'onesa' && s.user.mfa === true, 'MOBILE_ADMINISTRATOR'); break;
    case 'pasofi':
      check(s.staffId === id && s.email === email && s.role === 'admin' && s.status === 'approved' &&
        s.mfaVerified === true && Array.isArray(s.siteIds) && s.siteIds.length === 0, 'PASOFI_ADMINISTRATOR'); break;
    case 'logistics':
      check(typeof s.user?.id === 'string' && s.user.id.length > 0 && s.user.email === email && s.user.role === 'admin', 'LOGISTICS_ADMINISTRATOR'); break;
    case 'farmer':
      // Farmer admits only current Onesa global administrators to this exchange.
      // Its local UUID is an independent, persistent issuer/subject mapping.
      check(matches(s.id,UUID) && s.id === detail?.userId && s.username === 'onesa+' + s.id &&
        s.username === detail.username && s.language === detail.language, 'FARMER_ADMINISTRATOR'); break;
    default: throw new Failure('UNKNOWN_PRODUCT');
  }
}

export function permittedResource(origins,product,raw,method,kind) {
  let u; try { u = new URL(raw); } catch { return false; }
  const portal = u.origin === origins.portal, app = PRODUCTS[product];
  if (u.protocol !== 'https:' || u.username || u.password || (!portal && (!app || u.origin !== origins[product]))) return false;
  const p = u.pathname;
  if (method === 'POST') {
    if (portal) return product ? interactionWrite.test(p) : p === '/api/v1/account/login';
    return [app.start,app.complete].includes(p) && !(product === 'mobile' && p === app.start);
  }
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (portal && ((!product && isAccountEntry(u)) || (product && isProductSignIn(u)) || interactionRead.test(p) || p === '/api/v1/account/config' ||
    p === '/api/v1/account/me' || product && (p === authorize || resume.test(p)))) return true;
  if (!portal && (p === app.callback || p === app.session || p === app.config || (product === 'mobile' && p === app.start) ||
    p === new URL(app.entry,u.origin).pathname || p === '/' || (product === 'drone' && p === '/api/v1/auth/workspaces') ||
    (product === 'robot' && p === '/api/v1/status') || (product === 'farmer' && p === '/v1/farms'))) return true;
  // Permit same-origin static UI resources, never arbitrary API reads or writes.
  if (/^\/(?:api|v1)(?:\/|$)/.test(p)) return false;
  return ['script','stylesheet','image','font','manifest'].includes(kind) ||
    /^\/(?:_next\/static|assets|static)\//.test(p);
}

async function readJSON(response) {
  check(response.ok(), 'SESSION_RESPONSE');
  const bytes = await response.body();
  check(bytes.length < 256*1024,'SESSION_RESPONSE_BOUNDS');
  return JSON.parse(bytes.toString('utf8'));
}

async function getSession(context,origin,path,token) {
  const res = await context.request.get(origin + path,{maxRedirects:0,timeout:15000,
    headers:{Accept:'application/json',...(token ? {Authorization:'Bearer ' + token} : {})}});
  try { return await readJSON(res); } finally { await res.dispose(); }
}

export function permittedRedirect(origins, product, event) {
  const status = event.responseStatusCode;
  if (![301, 302, 303, 307, 308].includes(status)) return true;
  // All seven auth POST endpoints return JSON, including MFA and consent.
  // Never allow a redirect to replay a request body or forward an API bearer.
  const {url, method, headers} = event.request;
  if (!['GET', 'HEAD'].includes(method) || Object.keys(headers).some(name => name.toLowerCase() === 'authorization')) return false;
  const locations = (event.responseHeaders ?? []).filter(header => header.name.toLowerCase() === 'location');
  if (locations.length !== 1) return false;
  let target;
  try { target = new URL(locations[0].value, url); } catch { return false; }
  return permittedResource(origins, product, target.href, method, event.resourceType.toLowerCase());
}

export async function installGuard(page, request, product) {
  await page.route('**/*', route => {
    const resource = route.request();
    return permittedResource(request.origins, product, resource.url(), resource.method(), resource.resourceType())
      ? route.continue() : route.abort();
  });
  // Playwright's route handler receives only the first URL in a redirect
  // chain. Check every actual Chromium redirect before the browser follows it.
  const session = await page.context().newCDPSession(page);
  session.on('Fetch.requestPaused', event => {
    const allowed = permittedRedirect(request.origins, product, event);
    const action = allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest';
    const params = allowed ? {requestId:event.requestId} : {requestId:event.requestId,errorReason:'BlockedByClient'};
    // A closed/detached target cannot resume a paused request.
    void session.send(action, params).catch(() => {});
  });
  await session.send('Fetch.enable', {patterns:[{urlPattern:'*',requestStage:'Response'}]});
}

// A locator can re-resolve in a new document after navigation. Pin each private
// fill to its actual Portal input so a redirected product form cannot receive it.
export async function fillPortalInput(locator, expectedUrl, value) {
  const element = await locator.elementHandle({timeout:15000});
  try {
    check(element && await element.evaluate(node => node.ownerDocument.location.href) === expectedUrl,
      'CREDENTIAL_DOCUMENT_CHANGED');
    await element.fill(value, {timeout:10000});
  } finally { await element?.dispose(); }
}

async function submitMfa(page,request) {
  const owner = request.fixtures.owner, current = new URL(page.url());
  check(current.origin === request.origins.portal && (isAccountEntry(current) || isProductSignIn(current)), 'CREDENTIAL_ORIGIN');
  const email = page.locator('input[name="email"]'), password = page.locator('input[name="password"]'),
    code = page.locator('input[name="code"]'), submit = page.getByRole('button',{name:'Continue',exact:true});
  await email.waitFor({state:'visible'});
  await fillPortalInput(email,current.href,owner.email);
  await fillPortalInput(password,current.href,owner.password);
  if (!await code.isVisible()) {
    await submit.click();
    await code.waitFor({state:'visible'});
  }
  // The legacy runner may have used the immediately preceding TOTP code.
  const step = Math.floor(Date.now()/30000)+1;
  await delay(step*30000 + 900 - Date.now());
  check(page.url() === current.href,'CREDENTIAL_ORIGIN_CHANGED');
  await fillPortalInput(code,current.href,totp(owner.totp_secret,step));
  await submit.click();
}

async function sharedContext(browser,request) {
  const context = await browser.newContext({locale:'en-GB',serviceWorkers:'block'});
  try {
    // Page routes take priority. Unobserved pages, including the first
    // request of a popup, have no permitted routes in this shared cookie jar.
    await context.route('**/*', route => route.abort());
    // No control/telemetry socket is needed to establish identity on any product.
    await context.routeWebSocket('**/*', socket => socket.close());
    for (const preview of Object.values(request.preview_sessions)) {
      const isolated = await browser.newContext();
      try {
        await establishPreviewSession(isolated,preview.origin,preview.bypass_secret);
        const cookies = await isolated.cookies(preview.origin);
        check(cookies.length === 1 && cookies[0].secure && cookies[0].name === '_vercel_jwt' &&
          cookies[0].domain.replace(/^\./,'') === new URL(preview.origin).hostname, 'PREVIEW_COOKIE_SCOPE');
        await context.addCookies([{name:'_vercel_jwt',value:cookies[0].value,url:preview.origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
      } finally { await isolated.close(); }
    }
    return context;
  } catch (error) { await context.close(); throw error; }
}

async function observeProduct(context,r,product,principal,seen) {
  const page = await context.newPage(), app = PRODUCTS[product], origin = r.origins[product];
  let binding, callback, exchangeResponse, failure;
  const frameRequest = resource => {
    if (failure || !resource.isNavigationRequest() || resource.frame() !== page.mainFrame()) return;
    try {
      const u = new URL(resource.url());
      check(u.origin === origin || u.origin === r.origins.portal, 'PRODUCT_REDIRECT_ORIGIN');
      if (u.origin === r.origins.portal && u.pathname === authorize) {
        check(!binding,'DUPLICATE_AUTHORIZATION');
        binding = authorizationBinding(u.href,r,product);
        check(!seen.has(binding.state) && !seen.has(binding.nonce) && binding.state !== binding.nonce, 'REUSED_TRANSACTION');
        seen.add(binding.state); seen.add(binding.nonce);
      }
      if (u.origin === origin && u.pathname === app.callback) {
        check(binding && !callback, 'UNBOUND_CALLBACK');
        verifyCallback(u.href,binding,r.origins.portal);
        callback = true;
      }
    } catch { failure = new Failure('PRODUCT_NAVIGATION_BINDING'); }
  };
  const captureExchange = response => {
    if (product === 'farmer' && response.url() === origin + app.complete && response.request().method() === 'POST' &&
      response.request().frame() === page.mainFrame()) {
      if (!callback || exchangeResponse) failure = new Failure('FARMER_EXCHANGE_BINDING');
      else exchangeResponse = response;
    }
  };
  try {
    await installGuard(page,r,product);
    page.on('request',frameRequest);
    page.on('response',captureExchange);
    await page.goto(origin+app.entry,{waitUntil:'domcontentloaded'});
    await page.getByRole(app.role ?? 'button',{name:app.label,exact:true}).click({timeout:25000});
    const deadline = Date.now()+110000;
    let session, detail;
    while (Date.now() < deadline && !session) {
      if (failure) throw failure;
      const u = new URL(page.url());
      if (binding && u.origin === r.origins.portal && isProductSignIn(u)) {
        const continuation = page.getByRole('button',{name:'Continue as '+principal.email,exact:true});
        if (await continuation.isVisible()) {
          await continuation.click();
          await page.waitForURL(url=>url.href !== u.href,{timeout:20000});
        } else {
          check(!await page.getByRole('button',{name:/^Continue as /}).isVisible(),'PRODUCT_SSO_PRINCIPAL');
          if (await page.locator('input[name="email"]').isVisible()) {
            // Only these two clients explicitly request fresh MFA. Never silently
            // start a second account sign-in for any of the other products.
            check(app.mfa && await page.locator('input[name="code"]').isVisible(),'PRODUCT_SSO_SESSION');
            await submitMfa(page,r);
            await page.waitForURL(url=>url.href !== u.href,{timeout:20000});
          }
        }
      }
      if (callback && !failure && u.origin === origin) {
        if (product === 'farmer' && exchangeResponse) {
          // Constrain bearer transport to GET on this exact product; never follow redirects.
          const {userId,username,language,token} = await readJSON(exchangeResponse);
          check(matches(token,/^[A-Za-z0-9_-]{43}$/) && matches(userId,UUID), 'FARMER_EXCHANGE');
          detail = {userId,username,language};
          session = await getSession(context,origin,app.session,token);
        } else if (product !== 'farmer') {
          const response = await context.request.get(origin+app.session,{maxRedirects:0,timeout:10000});
          try {
            if (response.ok()) {
              const candidate = await readJSON(response);
              if (product !== 'mobile' || candidate.authenticated === true) session = candidate;
            } else check([401,403].includes(response.status()),'PRODUCT_SESSION_UNAVAILABLE');
          } finally { await response.dispose(); }
        }
      }
      if (!session) await delay(200);
    }
    if (failure) throw failure;
    check(binding && callback && session,'PRODUCT_SIGNIN_TIMEOUT');
    if (product === 'robot') detail = await getSession(context,origin,'/api/v1/status');
    if (product === 'drone') detail = await getSession(context,origin,'/api/v1/auth/workspaces');
    validateProduct(product,session,principal,detail,r);
    portalPrincipal(await getSession(context,r.origins.portal,'/api/v1/account/me'),r.fixtures.owner,principal);
  } finally {
    page.off('request',frameRequest);
    page.off('response',captureExchange);
    await page.close();
  }
}

export async function observeHostedAdministrator(input, launch) {
  const r = validateRequest(input);
  const browser = await (launch ?? (()=>createRequire(new URL('../../onesa-company-portal-frontend/package.json',import.meta.url))('@playwright/test').chromium.launch({headless:true})))();
  try {
    const context = await sharedContext(browser,r);
    try {
      const page = await context.newPage();
      let principal;
      try {
        await installGuard(page,r,null);
        await page.goto(r.origins.portal+'/account',{waitUntil:'domcontentloaded'});
        await submitMfa(page,r);
        await page.getByRole('heading',{name:'Your applications',exact:true}).waitFor({state:'visible',timeout:20000});
        principal = portalPrincipal(await getSession(context,r.origins.portal,'/api/v1/account/me'),r.fixtures.owner);
      } finally { await page.close(); }
      const checks = {portal_mfa_administrator:true};
      const seen = new Set();
      if (r.scope === 'integrated') for (const product of Object.keys(PRODUCTS)) {
        await observeProduct(context,r,product,principal,seen);
        checks[product+'_administrator'] = true;
      }
      return {schema_version:2,state:'HOSTED_ADMINISTRATOR_SIGNIN_OBSERVED_NOT_AUTHORIZATION',binding:r.binding,
        environment:r.environment,operation_id:r.operation_id,scope:r.scope,checks,physical_hardware_authorized:false,
        physical_operations:0,observed_at:new Date().toISOString()};
    } finally { await context.close(); }
  } finally { await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    check(process.argv.length === 2,'STDIN_ONLY');
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; check(size <= 65536,'REQUEST_BOUNDS'); chunks.push(chunk); }
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const deadline = setTimeout(()=>{process.stderr.write('ADMINISTRATOR_OBSERVATION_TIMEOUT\n');process.exit(1);},1200000);
    try { process.stdout.write(JSON.stringify(await observeHostedAdministrator(request))+'\n'); }
    finally { clearTimeout(deadline); }
  } catch (error) {
    // Browser errors can contain callback URLs, credentials and one-time codes.
    process.stderr.write((error instanceof Failure ? error.message : 'HOSTED_ADMINISTRATOR_OBSERVATION_FAILED')+'\n');
    process.exitCode = 1;
  }
}
