import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {governanceSeed} from './governance-fixture.js';
import {normalizeSeed} from '../src/governance/seed.js';
import {governanceTarget} from '../src/governance/target.js';
if(!process.env.TEST_DATABASE_URL||!new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test'))throw new Error('Governance tests require an isolated _test database');
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;process.env.NODE_ENV='test';process.env.COMPANY_ORIGIN='';
process.env.SESSION_KEY=randomBytes(32).toString('hex');process.env.PUBLIC_ORIGIN='http://localhost:3300';
process.env.STORAGE_DIR=await mkdtemp(join(tmpdir(),'onesa-governance-test-'));
process.env.S3_BUCKET='';process.env.S3_ENDPOINT='';process.env.AWS_ENDPOINT_URL_S3='';process.env.MAIL_PROVIDER='smtp';process.env.SMTP_HOST='';process.env.RESEND_API_KEY='synthetic-disabled-provider';process.env.NOTIFY_EMAIL='synthetic@example.invalid';
const {db}=await import('../src/services/db.js'),{migrate}=await import('../src/services/migrate.js');
const {buildApp}=await import('../src/app.js'),{importGovernance}=await import('../src/governance/import.js');
const {hash,passwordHash,encrypt}=await import('../src/auth/crypto.js');
const app=await buildApp({logging:false}),password=randomBytes(32).toString('hex'),actors=new Map<string,{id:string;headers:{cookie:string;'x-csrf-token':string;origin:string}}>();
before(async()=>{
 await migrate();await db.query('TRUNCATE governance_events,governance_versions,governance_records,audit,users CASCADE');
 for(const role of ['owner','administrator','editor','business','hr','viewer']){const id=randomUUID(),raw=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');await db.query('INSERT INTO users(id,email,password_hash,role,mfa_secret) VALUES($1,$2,$3,$4,$5)',[id,`governance-${id}@example.invalid`,passwordHash(password),role,encrypt('JBSWY3DPEHPK3PXP')]);await db.query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[hash(raw),id,csrf]);actors.set(role,{id,headers:{cookie:'onesa_session='+raw,'x-csrf-token':csrf,origin:process.env.PUBLIC_ORIGIN!}});}
 await app.ready();
});
after(async()=>{await app.close();await db.end();await rm(process.env.STORAGE_DIR!,{recursive:true,force:true});});
const prefix='/api/v1/admin/governance';
const owner=()=>actors.get('owner')!;
async function proof(){const code=randomUUID();await db.query('INSERT INTO mfa_recovery(user_id,code_hash) VALUES($1,$2)',[owner().id,hash(code)]);return {password,code};}
test('Package validation rejects approval/deletion injection, duplicates and missing decisions',()=>{
 const seed=governanceSeed(),normalized=normalizeSeed(seed);assert.equal(normalized.records.length,40);
 const unsafe=structuredClone(seed);unsafe.retention_rules[0].enabled_for_automatic_deletion=true;assert.throws(()=>normalizeSeed(unsafe));
 const approved=structuredClone(seed);approved.privacy_decisions[0].status='APPROVED';assert.throws(()=>normalizeSeed(approved));
 const duplicate=structuredClone(seed);duplicate.retention_rules[1].rule_id=duplicate.retention_rules[0].rule_id;assert.throws(()=>normalizeSeed(duplicate));
 const incomplete=structuredClone(seed);incomplete.privacy_decisions.pop();assert.throws(()=>normalizeSeed(incomplete));
});
test('Actual import is atomic, insert-only and idempotent with exact stable IDs and no publication',async()=>{
 const oldSettings=(await db.query("SELECT value FROM settings WHERE key IN ('legal','retention') ORDER BY key")).rows;
 const first=await importGovernance(governanceSeed());assert.equal(first.inserted.length,40);
 const second=await importGovernance(governanceSeed());assert.equal(second.inserted.length,0);assert.equal(second.preserved.length,40);
 assert.deepEqual(first.counts,[{kind:'decision',count:12},{kind:'document',count:3},{kind:'processor',count:9},{kind:'retention',count:16}]);
 const statuses=(await db.query('SELECT DISTINCT status FROM governance_versions')).rows;assert.deepEqual(statuses,[{status:'draft_pending_review'}]);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM governance_events')).rows[0].n,40);
 assert.deepEqual((await db.query("SELECT value FROM settings WHERE key IN ('legal','retention') ORDER BY key")).rows,oldSettings);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM content WHERE body LIKE '%Synthetic retention policy%'")).rows[0].n,0);
 const overview=await app.inject({url:prefix+'/overview',headers:owner().headers});assert.equal(overview.statusCode,200);assert.equal(overview.json().documents,3);assert.equal(overview.json().approvedDocuments,0);assert.equal(overview.json().automaticDeletionEnabled,false);
});
test('Every governance read, PDF, history and mutation enforces existing server roles and CSRF',async()=>{
 const urls=[prefix+'/overview',prefix+'/records',prefix+'/events',prefix+'/records/ONESA-PRIV-RET-001',prefix+'/records/ONESA-PRIV-RET-001/versions',prefix+'/records/ONESA-PRIV-RET-001/pdf'];
 for(const url of urls){assert.equal((await app.inject({url})).statusCode,401);for(const role of ['editor','business','hr','viewer'])assert.equal((await app.inject({url,headers:actors.get(role)!.headers})).statusCode,403);assert.equal((await app.inject({url,headers:actors.get('administrator')!.headers})).statusCode,200);}
 const denied=await app.inject({method:'PATCH',url:prefix+'/records/RET-01/archive',headers:{cookie:owner().headers.cookie,origin:owner().headers.origin},payload:{expectedRevision:1,archived:true}});assert.equal(denied.statusCode,403);
 assert.equal((await app.inject({url:'/api/v1/public/governance/records'})).statusCode,404);
});
test('Search, filters, bounded history and protected generated PDFs use actual database values',async()=>{
 const search=await app.inject({url:prefix+'/records?kind=retention&search=RET-01',headers:owner().headers});assert.equal(search.statusCode,200);assert.equal(search.json().total,1);
 const filtered=await app.inject({url:prefix+'/records?kind=processor&status=draft_pending_review',headers:owner().headers});assert.equal(filtered.json().total,9);
 const empty=await app.inject({url:prefix+'/records?kind=retention&page=100',headers:owner().headers});assert.equal(empty.json().total,16);assert.deepEqual(empty.json().items,[]);
 const history=await app.inject({url:prefix+'/records/ONESA-PRIV-RET-001/versions',headers:owner().headers});assert.equal(history.json().total,1);assert.equal('payload' in history.json().items[0],false);
 assert.equal((await app.inject({url:prefix+'/records/ONESA-PRIV-RET-001/versions?limit=21',headers:owner().headers})).statusCode,400);
 const pdf=await app.inject({url:prefix+'/records/ONESA-PRIV-RET-001/pdf',headers:owner().headers});assert.equal(pdf.statusCode,200,pdf.body);assert.equal(pdf.rawPayload.subarray(0,5).toString(),'%PDF-');assert.match(pdf.headers['cache-control']!,/private, no-store/);assert.equal(pdf.headers['x-content-type-options'],'nosniff');
});
test('Database constraints refuse incomplete approval evidence even outside the API',async()=>{
 await assert.rejects(db.query("UPDATE governance_versions SET status='approved',approved_by=$1,approved_email='synthetic@example.invalid',approved_at=now(),effective_at=now(),review_due_at=now()+interval '1 day',approval_scope='Synthetic test only',approval_evidence_refs=ARRAY['tests/synthetic/evidence'] WHERE record_id='DEC-02' AND revision=1",[owner().id]),{code:'23514'});
 assert.equal((await db.query("SELECT status FROM governance_versions WHERE record_id='DEC-02' AND revision=1")).rows[0].status,'draft_pending_review');
});
test('Only a fresh authenticated owner proof can approve one immutable version, with auditable scope',async()=>{
 const url=prefix+'/records/DEC-01/review',body={expectedRevision:1,verdict:'approved',note:'Synthetic isolated review only.',scope:'Synthetic test only; no production approval.',evidenceRefs:['tests/synthetic/evidence'],effectiveAt:new Date().toISOString(),reviewDueAt:new Date(Date.now()+30*86400000).toISOString()};
 assert.equal((await app.inject({method:'POST',url,headers:actors.get('administrator')!.headers,payload:body})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url,headers:owner().headers,payload:body})).statusCode,403);
 const stepUp=await proof(),approved=await app.inject({method:'POST',url,headers:owner().headers,payload:{...body,stepUp}});assert.equal(approved.statusCode,200,approved.body);const version=approved.json().version;
 assert.equal(version.status,'approved');assert.equal(version.approvedBy,owner().id);assert.equal(version.approvedRole,'owner');assert.ok(version.approvedAt);assert.equal(version.approvalScope,body.scope);
 assert.equal((await app.inject({method:'POST',url,headers:owner().headers,payload:{...body,stepUp}})).statusCode,409);
 await assert.rejects(db.query("UPDATE governance_versions SET title='changed' WHERE record_id='DEC-01' AND revision=1"),{code:'23514'});
 await assert.rejects(db.query("DELETE FROM governance_versions WHERE record_id='DEC-01' AND revision=1"),{code:'23514'});
 const events=await app.inject({url:prefix+'/events?stableId=DEC-01',headers:owner().headers});assert.equal(events.json().items[0].actorRole,'owner');assert.equal(events.json().items[0].scope,body.scope);assert.ok(!events.body.includes(password));assert.ok(!events.body.includes(stepUp.code));
 await assert.rejects(db.query("UPDATE governance_events SET note='changed' WHERE record_id='DEC-01'"),{code:'23514'});
 assert.equal((await app.inject({url:prefix+'/records/DEC-02',headers:owner().headers})).json().version.status,'draft_pending_review');
});
test('Amendments preserve approved source, prevent lost concurrent updates and survive app restart/import',async()=>{
 const old=(await app.inject({url:prefix+'/records/DEC-01',headers:owner().headers})).json();const v=old.version;
 const body={expectedRevision:1,title:v.title,owner:v.owner,productScopes:v.productScopes,versionLabel:'0.2',reviewDueAt:null,evidenceRefs:[],payload:{...v.payload,proposedPosition:'Amended synthetic proposal requiring a new review.'}};
 const results=await Promise.all([1,2].map(()=>app.inject({method:'POST',url:prefix+'/records/DEC-01/revisions',headers:owner().headers,payload:body})));assert.deepEqual(results.map(r=>r.statusCode).sort(),[201,409]);
 const prior=(await app.inject({url:prefix+'/records/DEC-01?revision=1',headers:owner().headers})).json();assert.deepEqual(prior.version,old.version);
 await importGovernance(governanceSeed());
 const secondApp=await buildApp({logging:false});try{const result=await secondApp.inject({url:prefix+'/records/DEC-01',headers:owner().headers});assert.equal(result.json().currentRevision,2);assert.equal(result.json().version.status,'draft_pending_review');assert.equal(result.json().effectiveRevision,1);}finally{await secondApp.close();}
});
test('Provisional TTLs and imported draft retention rules never delete application/enquiry business data',async()=>{
 const {tick}=await import('../src/jobs/worker.js');const id=randomUUID();
 await db.query("INSERT INTO enquiries(id,category,name,email,message,locale,status,created_at) VALUES($1,'general','Synthetic expiry test','expiry@example.invalid','Synthetic test only','en','closed',now()-interval '10 years')",[id]);
 await tick();assert.equal((await db.query('SELECT id FROM enquiries WHERE id=$1',[id])).rowCount,1);await db.query('DELETE FROM enquiries WHERE id=$1',[id]);
});

test('Import target guards distinguish Portal staging, production and isolated local tests',()=>{
 const staging='ep-morning-shadow-b9jkzgsz-pooler.c-7.eu-central-1.aws.neon.tech',production='ep-dark-boat-b91lg22g-pooler.c-7.eu-central-1.aws.neon.tech';
 const uri=(host:string)=>`postgresql://onesa_portal_app:synthetic@${host}/neondb?sslmode=verify-full&channel_binding=require`;
 for(const host of [staging,production])assert.equal(governanceTarget(uri(host),host,'neondb').hostname,host);
 assert.throws(()=>governanceTarget(uri(production),staging,'neondb'));
 assert.throws(()=>governanceTarget(uri(staging).replace('verify-full','require'),staging,'neondb'));
 assert.throws(()=>governanceTarget(uri(staging).replace('onesa_portal_app','neondb_owner'),staging,'neondb'));
 assert.throws(()=>governanceTarget(uri(staging).replace(staging,'unrelated.example.invalid'),'unrelated.example.invalid','neondb'));
 assert.equal(governanceTarget('postgresql://synthetic:synthetic@127.0.0.1:55440/onesa_portal_test','127.0.0.1','onesa_portal_test').port,'55440');
 assert.throws(()=>governanceTarget('postgresql://synthetic:synthetic@127.0.0.1:55440/onesa_portal','127.0.0.1','onesa_portal'));
});
