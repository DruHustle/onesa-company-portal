// Synthetic local TLS only. No credentials, application database or provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import {readFileSync,mkdtempSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const config={"modules":["onesa-company-portal-backend/src/security/tls-trust.ts","onesa-company-portal-frontend/src/lib/server/tls-trust.ts"],"hooks":[["onesa-company-portal-backend/src/server.ts","import {tlsTrustPolicy} from './security/tls-trust.js';"],["onesa-company-portal-backend/src/jobs/worker.ts","import {tlsTrustPolicy} from '../security/tls-trust.js';"],["onesa-company-portal-backend/src/services/db.ts","import '../security/tls-trust.js';"],["onesa-company-portal-frontend/src/lib/api/server.ts","import '../server/tls-trust';"],["onesa-company-portal-frontend/src/app/api/v1/[...path]/route.ts","import '@/lib/server/tls-trust';"],["onesa-company-portal-frontend/src/app/engineering/sign-in/[uid]/[action]/route.ts","import '@/lib/server/tls-trust';"]],"instrumentation":["onesa-company-portal-frontend/src/instrumentation.ts"]};
const fingerprint='86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b';
const fixture=resolve(root,'scripts/fixtures/emsign-ecc-g3-public-cert.txt');
const child=`
import assert from 'node:assert/strict';
import tls from 'node:tls';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {X509Certificate} from 'node:crypto';
const [file,fixture,folder,scenario]=process.argv.slice(1);
const fingerprint='86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b';
const id=p=>new X509Certificate(p).fingerprint256.replaceAll(':','').toLowerCase();
const bad=readFileSync(fixture,'utf8'),good=readFileSync(folder+'/good.pem','utf8');
if(scenario==='unsupported'){tls.setDefaultCACertificates=undefined;syncBuiltinESMExports();}
if(scenario==='empty')tls.setDefaultCACertificates([bad]);
else if(scenario==='already-safe')tls.setDefaultCACertificates(tls.getCACertificates('default').filter(p=>id(p)!==fingerprint));
else if(scenario!=='unsupported')tls.setDefaultCACertificates([...tls.getCACertificates('default'),bad,good]);
const before=typeof tls.getCACertificates==='function'?tls.getCACertificates('default'):[];
const mod=await import(pathToFileURL(file).href);
assert(!['unsupported','empty','bypass'].includes(scenario),'Unsafe scenario must fail before serving');
const after=tls.getCACertificates('default');assert(after.length>0);assert(after.every(p=>id(p)!==fingerprint));
assert.deepEqual(new Set(after.map(id)),new Set(before.filter(p=>id(p)!==fingerprint).map(id)));
assert.equal(mod.activateTlsTrustPolicy().removed,0);assert.equal(mod.tlsTrustPolicy.blockedCAAbsent,true);
if(scenario==='already-safe'){assert.equal(mod.tlsTrustPolicy.removed,0);process.exit(0);}
assert(after.some(p=>id(p)===id(good)));assert.equal(mod.tlsTrustPolicy.removed,1);
const servers=[];
async function server(name){const s=https.createServer({key:readFileSync(folder+'/'+name+'.key'),cert:readFileSync(folder+'/'+name+'.pem')},(_,res)=>{res.writeHead(204);res.end()});servers.push(s);await new Promise((yes,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',yes)});return s.address().port;}
async function get(port,servername){return new Promise((yes,no)=>{const r=https.get({hostname:'127.0.0.1',port,servername,agent:false,rejectUnauthorized:true},res=>{res.resume();yes(res.statusCode)});r.setTimeout(1500,()=>r.destroy(new Error('LOCAL_TLS_TIMEOUT')));r.once('error',no)})}
try{const a=await server('good'),b=await server('other');assert.equal(await get(a,'localhost'),204);const fetched=await fetch('https://127.0.0.1:'+a,{signal:AbortSignal.timeout(1500)});assert.equal(fetched.status,204);await fetched.body?.cancel();await assert.rejects(fetch('https://127.0.0.1:'+b,{signal:AbortSignal.timeout(1500)}),e=>['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(e.cause?.code));await assert.rejects(get(a,'wrong.example.invalid'),e=>e.code==='ERR_TLS_CERT_ALTNAME_INVALID');await assert.rejects(get(b,'localhost'),e=>['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(e.code));}
finally{await Promise.all(servers.map(s=>new Promise(r=>s.close(r))))}
`;
test('Known public CA fixture and runtime hooks are source-bound',()=>{
 assert.equal(new X509Certificate(readFileSync(fixture)).fingerprint256.replaceAll(':','').toLowerCase(),fingerprint);
 for(const[file,line]of config.hooks)assert(readFileSync(resolve(root,file),'utf8').startsWith(line+'\n'));
 for(const file of config.instrumentation){const source=readFileSync(resolve(root,file),'utf8');assert(source.includes("process.env.NEXT_RUNTIME === 'nodejs'"));assert(source.includes("await import('./lib/server/tls-trust')"));}
 if(config.modules.length===2)assert.equal(readFileSync(resolve(root,config.modules[0]),'utf8'),readFileSync(resolve(root,config.modules[1]),'utf8'));
});
for(const module of config.modules)test('Effective TLS policy: '+module,()=>{
 const folder=mkdtempSync(join(tmpdir(),'onesa-tls-policy-'));chmodSync(folder,0o700);
 try{
  for(const name of ['good','other']){const p=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',join(folder,name+'.key'),'-out',join(folder,name+'.pem'),'-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH}});assert.equal(p.status,0,'Synthetic fixture generation failed');chmodSync(join(folder,name+'.key'),0o600);}
  for(const scenario of ['normal','already-safe','unsupported','empty','bypass']){
   const p=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',child,resolve(root,module),fixture,folder,scenario],{encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,NODE_ENV:'test',...(scenario==='bypass'?{NODE_TLS_REJECT_UNAUTHORIZED:'0'}:{})}});
   if(['normal','already-safe'].includes(scenario))assert.equal(p.status,0,'TLS scenario failed: '+scenario+' '+p.stderr);
   else{assert.equal(p.status,1,'Unsafe TLS scenario did not stop');assert.match(p.stderr,scenario==='unsupported'?/requires the supported Node 24/:scenario==='empty'?/empty CA store/:/verification must remain enabled/);}
  }
 }finally{rmSync(folder,{recursive:true,force:true})}
});
