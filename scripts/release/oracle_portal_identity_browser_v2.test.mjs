import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PRODUCTS, authorizationBinding, permittedResource, permittedRedirect, fillPortalInput, portalPrincipal, validateProduct,
  validateRequest, observeHostedAdministrator} from './oracle_portal_identity_browser_v2.mjs';
import {productSignInLabel, verifyCallback} from './oracle_portal_identity_browser.mjs';

test('both observers match only the two exact Drone sign-in button labels', () => {
  for (const label of [productSignInLabel('drone'), PRODUCTS.drone.label]) {
    for (const accepted of ['Sign in with Onesa', 'Continue with Onesa']) assert.match(accepted, label);
    for (const other of ['Sign in', 'Sign in with Onesa administrator', 'Do not Continue with Onesa', 'sign in with onesa']) {
      assert.doesNotMatch(other, label);
    }
  }
  for (const product of ['ai', 'robot']) {
    assert.equal(productSignInLabel(product), 'Continue with Onesa');
    assert.equal(PRODUCTS[product].label, 'Continue with Onesa');
  }
});

const origins = {portal:'https://portal.onesa.eu',ai:'https://platform.onesa.eu',drone:'https://drone.onesa.eu',
  robot:'https://robot.onesa.eu',farmer:'https://farmer.onesa.eu',logistics:'https://logistics.onesa.eu',
  pasofi:'https://pasofi.mobile.onesa.eu',mobile:'https://mobile.onesa.eu'};
const products = ['ai','drone','robot','farmer','logistics','pasofi','mobile'];
const id = 'e8054d4b-c268-4489-977d-1445ab60d404', tenantId = '7b20fe91-7713-4140-bfaa-dd99877ea553';
const email = 'test-administrator@example.invalid';
function request(scope='integrated') {
  const hex = 'a'.repeat(64);
  return {schema_version:2,environment:'production',scope,operation_id:id,origins:{...origins},preview_sessions:{},
    binding:{repository:'DruHustle/onesa-company-portal',component:scope==='account'?'identity':'identity-acceptance',
      candidate_commit:'7'.repeat(40),source_tree:'8'.repeat(40),source_sha256:hex,build_sha256:hex,artifact_digest:'sha256:'+hex,
      configuration_sha256:{staging:hex,production:hex},target_environment:'production'},
    fixtures:{owner:{email,password:'Synthetic '+id,totp_secret:'A'.repeat(32)},drone_workspace:{tenant_id:tenantId,label:'Test'},
      product_clients:Object.fromEntries(products.map(p=>[p,'synthetic_client_'+p]))}};
}
function authorization(product,r=request()) {
  const app=PRODUCTS[product], u=new URL('/api/v1/identity/auth',r.origins.portal);
  u.search=new URLSearchParams({client_id:r.fixtures.product_clients[product],redirect_uri:r.origins[product]+app.callback,
    response_type:'code',scope:'openid email profile onesa',state:'A'.repeat(43),nonce:'B'.repeat(43),
    code_challenge:'C'.repeat(43),code_challenge_method:'S256',...(app.mfa?{max_age:'300',acr_values:'urn:onesa:mfa'}:{})}).toString();
  return u;
}

test('immutable standalone and consolidated source bindings and bounded private fixtures',()=>{
  for(const scope of ['account','integrated']) {
    const r=request(scope); assert.equal(validateRequest(r),r);
    Object.assign(r.binding,{schema_version:2,repository:'DruHustle/onesa-ug',repository_id:1444746154,product:'portal',
      source_path:'onesa-company-portal',product_source_tree:'9'.repeat(40),branch:'main'});
    assert.equal(validateRequest(r),r);
    for(const [key,bad] of Object.entries({component:'api',artifact_digest:'unpinned',branch:'staging',source_path:'foreign',repository_id:1,
      candidate_commit:'latest',repository:'Other/onesa-ug',authorization:true})) {
      const invalid=structuredClone(r); invalid.binding[key]=bad; assert.throws(()=>validateRequest(invalid));
    }
  }
  for(const change of [
    r=>delete r.origins.mobile, r=>r.origins.pasofi=r.origins.mobile, r=>r.origins.farmer+='/',
    r=>r.origins.ai='https://demo.invalid', r=>r.fixtures.owner.totp_secret='not-base32',
    r=>r.preview_sessions.ai={origin:r.origins.ai,bypass_secret:'x'.repeat(32)},
    r=>r.fixtures.product_clients.farmer=r.fixtures.product_clients.mobile,
    r=>r.fixtures.mailbox={}, r=>r.binding.unreviewed='secret', r=>r.scope='other',
  ]) { const r=request(); change(r); assert.throws(()=>validateRequest(r)); }
  const s=request(); s.environment='staging';
  s.origins=Object.fromEntries(Object.keys(origins).map(p=>[p,'https://onesa-'+p+'-staging.vercel.app']));
  s.origins.portal='https://onesa-company-portal-git-staging-druhustles-projects.vercel.app';
  s.origins.ai='https://onesa-ai-platform-git-staging-druhustles-projects.vercel.app';
  s.preview_sessions.ai={origin:s.origins.ai,bypass_secret:'x'.repeat(32)}; assert.equal(validateRequest(s),s);
  const foreign=structuredClone(s);foreign.origins.portal='https://foreign.example.test';assert.throws(()=>validateRequest(foreign));
  for(const fake of ['https://onesa-imposter.vercel.app',s.origins.ai,'https://farmer-staging.onesa.eu']) {
    const invalid=structuredClone(s);invalid.origins.portal=fake;assert.throws(()=>validateRequest(invalid));
  }
  const native=structuredClone(s);native.origins.farmer='https://farmer.native-operator.example';
  assert.doesNotThrow(()=>validateRequest(native)); // independently registered native callback with no Vercel bypass
  native.preview_sessions.farmer={origin:native.origins.farmer,bypass_secret:'x'.repeat(32)};
  assert.throws(()=>validateRequest(native));
  s.preview_sessions.ai.origin=s.origins.robot; assert.throws(()=>validateRequest(s));
});

test('each of seven products binds its actual navigation, client, issuer, PKCE, callback and freshness policy',()=>{
  const r=request(); assert.deepEqual(Object.keys(PRODUCTS),products);
  for(const product of products) {
    const good=authorization(product), binding=authorizationBinding(good.href,r,product), cb=new URL(binding.callback);
    cb.search=new URLSearchParams({code:'test_code_for_observation_only',state:binding.state,iss:r.origins.portal+'/api/v1/identity'}).toString();
    assert.doesNotThrow(()=>verifyCallback(cb.href,binding,r.origins.portal));
    for(const [k,bad] of Object.entries({client_id:r.fixtures.product_clients[product==='ai'?'robot':'ai'],scope:'openid',state:'short',
      redirect_uri:r.origins[product]+'/',nonce:'short',response_type:'token',code_challenge_method:'plain',code_challenge:'short',max_age:'900'})) {
      const u=new URL(good);u.searchParams.set(k,bad);assert.throws(()=>authorizationBinding(u.href,r,product));
    }
    const dup=new URL(good);dup.searchParams.append('state',binding.state);assert.throws(()=>authorizationBinding(dup.href,r,product));
    const foreign=new URL(good);foreign.hostname='other.invalid';assert.throws(()=>authorizationBinding(foreign.href,r,product));
    if(PRODUCTS[product].mfa) {const missing=new URL(good);missing.searchParams.delete('acr_values');assert.throws(()=>authorizationBinding(missing.href,r,product));}
    for(const [k,bad] of Object.entries({state:'wrong',iss:'https://foreign.invalid',code:'short'})){
      const changed=new URL(cb);changed.searchParams.set(k,bad);assert.throws(()=>verifyCallback(changed.href,binding,r.origins.portal));
    }
  }
});

const principal={id,email}, farmerId='10abcb36-db10-4d37-9f02-b76ce629e6c5';
const sessions={
  ai:{email,identity_mode:'onesa',global_admin:true,administrator:true},
  drone:{email,identity_managed:true,global_admin:true},
  robot:{authentication_method:'onesa',global_administrator:true,role:'administrator'},
  mobile:{authenticated:true,authMode:'onesa',mode:'production',ssoAvailable:true,user:{subject:id,role:'admin',source:'onesa',mfa:true}},
  pasofi:{staffId:id,email,role:'admin',status:'approved',mfaVerified:true,siteIds:[]},
  logistics:{user:{id:'2',email,role:'admin'}},
  farmer:{id:farmerId,username:'onesa+'+farmerId,language:'sn'},
};
const details={drone:{workspaces:[{id:tenantId,role:'admin'}]},robot:{mode:'simulation',physical_actuation:false,deployment_environment:'production'},
  farmer:{userId:farmerId,username:'onesa+'+farmerId,language:'sn'}};

test('administrator and product-specific current server evidence must agree',()=>{
  const r=request(),account={...principal,globalAdmin:true,portalAccess:true,emailVerified:true,mfaEnrolled:true};
  assert.deepEqual(portalPrincipal({account},r.fixtures.owner),principal);
  for(const key of Object.keys(account)) assert.throws(()=>portalPrincipal({account:{...account,[key]:false}},r.fixtures.owner));
  assert.throws(()=>portalPrincipal({account},r.fixtures.owner,{id:tenantId}));
  for(const product of products){
    assert.doesNotThrow(()=>validateProduct(product,sessions[product],principal,details[product],r));
    for(const key of Object.keys(sessions[product])){
      const s=structuredClone(sessions[product]);delete s[key];assert.throws(()=>validateProduct(product,s,principal,details[product],r));
    }
  }
  for(const [p,d] of [['robot',{...details.robot,physical_actuation:true}],['robot',{...details.robot,mode:'physical'}],
    ['drone',{workspaces:[{id:tenantId,role:'viewer'}]}],['farmer',{...details.farmer,userId:id}]]){
    assert.throws(()=>validateProduct(p,sessions[p],principal,d,r));
  }
  for(const key of ['subject','role','source','mfa']){
    const s=structuredClone(sessions.mobile);delete s.user[key];assert.throws(()=>validateProduct('mobile',s,principal,null,r));
  }
});

test('browser dispatch is limited to same-origin sign-in, read-only session and static application resources',()=>{
  const interaction='/api/v1/account/interaction/test_session/continue';
  assert.equal(permittedResource(origins,null,origins.portal+'/api/v1/account/login','POST','fetch'),true);
  for(const product of products){
    const allowed=(path,method='GET',kind='fetch')=>permittedResource(origins,product,origins[product]+path,method,kind);
    const a=PRODUCTS[product];
    assert.equal(allowed(a.session),true);
    assert.equal(allowed(a.callback),true);
    assert.equal(allowed('/assets/account.js','GET','script'),true);
    if(a.start) assert.equal(allowed(a.start,product==='mobile'?'GET':'POST'),true);
    if(a.complete) assert.equal(allowed(a.complete,'POST'),true);
    assert.equal(permittedResource(origins,product,origins.portal+interaction,'POST','fetch'),true);
    for(const path of ['/api/v1/commands','/api/staff/refunds','/api/v1/admin/physical-operation','/api/v1/stop','/v1/register','/api/funds/transfer']){
      for(const method of ['GET','POST','PATCH','DELETE']) assert.equal(allowed(path,method),false);
    }
    assert.equal(permittedResource(origins,product,'https://other.invalid'+a.callback,'GET','document'),false);
    assert.equal(permittedResource(origins,product,origins.portal+'/api/v1/admin/users','POST','fetch'),false);
    assert.equal(permittedResource(origins,product,origins.portal+'/api/v1/account/login','POST','fetch'),false);
  }
});

test('native Chromium redirects cannot replay authentication posts, bearers or leave the selected issuer/client',()=>{
  const issuer=origins.portal, start=origins.mobile+PRODUCTS.mobile.start;
  const event=(from, to, method='GET',status=302) => ({
    responseStatusCode:status, request:{url:from,method,headers:{}}, resourceType:'Document',
    responseHeaders:[{name:'Location',value:to}],
  });
  const destination=issuer+'/api/v1/identity/auth';
  assert.equal(permittedRedirect(origins,'mobile',event(start,destination)),true);
  assert.equal(permittedRedirect(origins,'mobile',event(destination,'/account?interaction=test_flow')),true);
  for (const invalid of ['/admin', '/account?interaction=short', '/account?interaction=test_flow&next=/', '/account?interaction=test_flow#private', '/engineering/sign-in/test_flow', '/account/sign-in/test_flow']) {
    assert.equal(permittedRedirect(origins,'mobile',event(destination,invalid)),false);
  }
  assert.equal(permittedRedirect(origins,'mobile',event(destination,origins.mobile+PRODUCTS.mobile.callback)),true);
  for(const status of [301,302,303,307,308]) {
    assert.equal(permittedRedirect(origins,'mobile',event(start,'https://foreign.example/','GET',status)),false);
    assert.equal(permittedRedirect(origins,null,event(issuer+'/api/v1/account/login',issuer+'/account','POST',status)),false);
    assert.equal(permittedRedirect(origins,'mobile',event(start,origins.mobile+'/api/staff/refunds','GET',status)),false);
    assert.equal(permittedRedirect(origins,'mobile',event(start,origins.pasofi+PRODUCTS.pasofi.callback,'GET',status)),false);
  }
  const bearer=event(origins.farmer+'/v1/me','/v1/farms');bearer.request.headers.Authorization='Bearer synthetic';
  assert.equal(permittedRedirect(origins,'farmer',bearer),false);
  const multiple=event(start,destination);multiple.responseHeaders.push({name:'location',value:destination});
  assert.equal(permittedRedirect(origins,'mobile',multiple),false);
});

test('private fields can only receive a value in the exact still-attached Portal document',async()=>{
  const portal=origins.portal+'/account', other=origins.mobile+'/account';
  let fills=0, disposed=0;
  const locator=url=>({elementHandle:async()=>({evaluate:async fn=>fn({ownerDocument:{location:{href:url}}}),
    fill:async()=>{fills++;},dispose:async()=>{disposed++;}})});
  await fillPortalInput(locator(portal),portal,'synthetic');assert.equal(fills,1);
  await assert.rejects(fillPortalInput(locator(other),portal,'synthetic'));
  assert.equal(fills,1);assert.equal(disposed,2);
});

test('invalid input is rejected before launching, and CLI errors redact private input',async()=>{
  let launched=false; const r=request(); r.binding.debug=r.fixtures.owner.password;
  await assert.rejects(observeHostedAdministrator(r,async()=>{launched=true;}));assert.equal(launched,false);
  const cli=fileURLToPath(new URL('./oracle_portal_identity_browser_v2.mjs',import.meta.url));
  const run=spawnSync(process.execPath,[cli],{input:JSON.stringify(r),encoding:'utf8'});
  assert.equal(run.status,1);assert.equal(run.stdout,'');assert.equal(run.stderr,'SOURCE_BINDING\n');
});
