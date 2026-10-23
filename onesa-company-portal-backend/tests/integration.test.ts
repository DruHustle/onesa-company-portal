import './local-environment.js';
import {test,after} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
if(!process.env.TEST_DATABASE_URL)throw new Error('TEST_DATABASE_URL must reference an isolated PostgreSQL test database');
if(!new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test'))throw new Error('Refusing to test a database without the _test suffix');
process.env.COMPANY_ORIGIN='http://company.example.invalid';process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;process.env.NODE_ENV='test';process.env.STORAGE_DIR=await mkdtemp(join(tmpdir(),'onesa-portal-test-'));process.env.CLAMAV_HOST='';process.env.MAIL_PROVIDER='smtp';process.env.SMTP_HOST='';process.env.RESEND_API_KEY='synthetic-disabled-provider';process.env.S3_BUCKET='';process.env.S3_ENDPOINT='';process.env.AWS_ENDPOINT_URL_S3='';
const {db}=await import('../src/services/db.js');const {migrate}=await import('../src/services/migrate.js');const {seedTemplates}=await import('../src/services/workflows.js');const {passwordHash,encrypt,hash,totp}=await import('../src/auth/crypto.js');const {buildApp}=await import('../src/app.js');const {generatePDF}=await import('../src/documents/pdf.js');
await migrate();await migrate();await db.query('TRUNCATE audit,jobs,mfa_recovery,recovery_tokens,sessions,applications,files,enquiries,revisions,content,users,rate_limits RESTART IDENTITY CASCADE');await seedTemplates();const app=await buildApp({logging:false});await app.ready();
after(async()=>{await app.close();await db.end();await rm(process.env.STORAGE_DIR!,{recursive:true,force:true});});
const password='integration-password-1234';const secret='JBSWY3DPEHPK3PXP';
async function account(role:string){const id=randomUUID(),email=role+'-'+id+'@example.test';await db.query('INSERT INTO users(id,email,password_hash,role,mfa_secret) VALUES($1,$2,$3,$4,$5)',[id,email,passwordHash(password),role,encrypt(secret)]);return {id,email};}
async function login(u:{id:string;email:string}){const code=randomUUID();await db.query('INSERT INTO mfa_recovery VALUES($1,$2)',[u.id,hash(code)]);const r=await app.inject({method:'POST',url:'/api/v1/auth/login',remoteAddress:`2001:db8:${u.id.slice(0,4)}:${u.id.slice(4,8)}::1`,payload:{email:u.email,password,code}});assert.equal(r.statusCode,200,r.body);return {cookie:r.cookies[0].name+'='+r.cookies[0].value,'x-csrf-token':r.json().csrf,origin:process.env.PUBLIC_ORIGIN||'http://localhost:3300'};}
const owner=await account('owner'),editor=await account('editor'),hr=await account('hr'),business=await account('business'),viewer=await account('viewer');const ownerH=await login(owner),editorH=await login(editor),hrH=await login(hr),businessH=await login(business),viewerH=await login(viewer);
const article={kind:'article',slug:'verified-test-story',locale:'en',title:'Workflow test story',summary:'Integration fixture',body:'This is a test fixture, not a company announcement.',state:'draft',metadata:{category:'Testing',author:'Test editor'}};

test('Launch content delivery excludes unrelated recruitment readiness while applicant intake stays gated',async()=>{
 const {env}=await import('../src/config/env.js');
 const {releaseReady}=await import('../src/services/workflows.js');
 const before={node:env.NODE_ENV,stage:env.PUBLICATION_STAGE,publish:env.PUBLISH_ENABLED};
 const legalBefore=(await db.query("SELECT value FROM settings WHERE key='legal'")).rows[0].value;
 const keys=['legal_name','register_number','register_court','director','address','contact_email'];
 const factsBefore=(await db.query('SELECT * FROM facts WHERE key=ANY($1)',[keys])).rows;
 const pages:string[]=[];
 try{
  const document=await app.inject({method:'POST',url:'/api/v1/admin/templates/company-profile/generate',headers:ownerH,payload:{classification:'internal'}});
  assert.equal(document.statusCode,201,document.body);const documentId=document.json().id;
  assert.equal((await app.inject({method:'PATCH',url:'/api/v1/admin/files/'+documentId,headers:ownerH,payload:{title:'Synthetic public release document',classification:'public',approval:'approved',reviewAt:null,archived:false}})).statusCode,200);
  const draft={...article,slug:'recruitment-independent-story'};
  const created=await app.inject({method:'POST',url:'/api/v1/admin/content',headers:ownerH,payload:draft});assert.equal(created.statusCode,201,created.body);
  const contentId=created.json().id;
  assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/content/'+contentId+'/review',headers:ownerH,payload:{expectedRevision:1,verdict:'approved',note:'Synthetic exact-revision approval.'}})).statusCode,200);
  assert.equal((await app.inject({method:'PATCH',url:'/api/v1/admin/content/'+contentId,headers:ownerH,payload:{...draft,revision:2,state:'published'}})).statusCode,200);
  for(const locale of ['en','de'])for(const slug of ['impressum','privacy']){
   const id=randomUUID();pages.push(id);
   await db.query("INSERT INTO content(id,kind,slug,locale,title,body,state) VALUES($1,'page',$2,$3,'Synthetic notice',$4,'published')",[id,slug,locale,'Isolated synthetic notice. '.repeat(12)]);
  }
  for(const key of keys)await db.query("INSERT INTO facts(key,value,status,source) VALUES($1,'Synthetic verified value','verified','Isolated regression fixture') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,status=EXCLUDED.status,source=EXCLUDED.source",[key]);
  const legal={impressumApproved:true,privacyApproved:true,providersReviewed:true,recruitmentApproved:false};
  await db.query("UPDATE settings SET value=$1 WHERE key='legal'",[JSON.stringify(legal)]);
  env.NODE_ENV='production';env.PUBLICATION_STAGE='launch';env.PUBLISH_ENABLED='true';
  assert.equal(await releaseReady(),false,'Whole-company launch readiness still includes recruitment');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM facts WHERE key=ANY($1) AND status='verified' AND value IS NOT NULL",[keys])).rows[0].n,6,'All synthetic company facts are ready');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM published_content WHERE kind='page' AND slug IN ('impressum','privacy') AND state='published' AND length(body)>200")).rows[0].n,4,'Four synthetic notices are live');
  const publicUrl='/api/v1/public/content/article/en/'+draft.slug;
  assert.equal((await app.inject({url:publicUrl})).statusCode,200,'Reviewed public content must not depend on recruitment approval');
  const download=await app.inject({url:'/api/v1/public/files/'+documentId+'/download'});
  assert.equal(download.statusCode,200);assert.equal(download.rawPayload.subarray(0,5).toString(),'%PDF-');
  assert.equal((await app.inject({url:'/api/v1/public/files'})).statusCode,200);
  const working=await app.inject({method:'POST',url:'/api/v1/admin/content',headers:ownerH,payload:{...article,slug:'recruitment-independent-draft'}});assert.equal(working.statusCode,201);
  const unreviewed=await app.inject({method:'PATCH',url:'/api/v1/admin/content/'+working.json().id,headers:ownerH,payload:{...article,slug:'recruitment-independent-draft',revision:1,state:'published'}});
  assert.equal(unreviewed.statusCode,409);assert.equal(unreviewed.json().error.code,'EDITORIAL_REVIEW');
  assert.equal((await app.inject({url:'/api/v1/public/content/article/en/recruitment-independent-draft'})).statusCode,404);
  const fileCount=(await db.query('SELECT count(*)::int AS n FROM files')).rows[0].n;
  const intake=await app.inject({method:'POST',url:'/api/v1/public/applications',remoteAddress:'2001:db8:fafa::1',payload:{jobId:randomUUID(),name:'Synthetic applicant',email:'synthetic@example.invalid',filename:'synthetic.pdf',base64:(await generatePDF('Synthetic','Isolated only')).toString('base64'),consent:true}});
  assert.equal(intake.statusCode,409);assert.equal(intake.json().error.code,'LEGAL_GATE');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM files')).rows[0].n,fileCount,'Refused intake writes no file');
  legal.privacyApproved=false;await db.query("UPDATE settings SET value=$1 WHERE key='legal'",[JSON.stringify(legal)]);
  assert.equal((await app.inject({url:publicUrl})).statusCode,409,'Applicable privacy readiness still gates delivery');
  legal.privacyApproved=true;await db.query("UPDATE settings SET value=$1 WHERE key='legal'",[JSON.stringify(legal)]);
  env.PUBLISH_ENABLED='false';assert.equal((await app.inject({url:publicUrl})).statusCode,409);
 }finally{
  env.NODE_ENV=before.node;env.PUBLICATION_STAGE=before.stage;env.PUBLISH_ENABLED=before.publish;
  await db.query("UPDATE settings SET value=$1 WHERE key='legal'",[JSON.stringify(legalBefore)]);
  await db.query('DELETE FROM facts WHERE key=ANY($1)',[keys]);
  for(const fact of factsBefore)await db.query('INSERT INTO facts(key,value,status,source,verified_by,verified_at) VALUES($1,$2,$3,$4,$5,$6)',[fact.key,fact.value,fact.status,fact.source,fact.verified_by,fact.verified_at]);
  await db.query('DELETE FROM content WHERE id=ANY($1::uuid[])',[pages]);
 }
});
let articleId='',jobId='',applicationId='',fileId='',generatedId='';
test('Expired final worker leases fail without a sixth email or storage attempt',async()=>{
 const {tick}=await import('../src/jobs/worker.js');
 const job=randomUUID(),key=randomUUID();
 await db.query("INSERT INTO jobs(id,kind,dedupe_key,payload,status,attempts,locked_at) VALUES($1,'email',$2,'{}','running',5,now()-interval '6 minutes')",[job,'crash-final:'+job]);
 await db.query("INSERT INTO storage_deletions(storage_key,status,attempts,locked_at) VALUES($1,'running',5,now()-interval '6 minutes')",[key]);
 const activeJob=randomUUID(),retryJob=randomUUID(),pendingJob=randomUUID(),activeKey=randomUUID(),retryKey=randomUUID();
 await db.query("INSERT INTO jobs(id,kind,dedupe_key,payload,status,attempts,locked_at) VALUES($1::uuid,'email',($1::uuid)::text,'{}','running',5,now()),($2::uuid,'email',($2::uuid)::text,'{}','running',4,now()-interval '6 minutes'),($3::uuid,'email',($3::uuid)::text,'{}','pending',5,NULL)",[activeJob,retryJob,pendingJob]);
 await db.query("INSERT INTO storage_deletions(storage_key,status,attempts,locked_at) VALUES($1,'running',5,now()),($2,'running',4,now()-interval '6 minutes')",[activeKey,retryKey]);
 await tick();
 assert.equal((await db.query('SELECT status,attempts FROM jobs WHERE id=$1',[job])).rows[0].status,'failed');
 assert.deepEqual((await db.query('SELECT status,attempts FROM storage_deletions WHERE storage_key=$1',[key])).rows[0],{status:'failed',attempts:5});
 for(const [id,status] of [[activeJob,'running'],[retryJob,'pending'],[pendingJob,'failed']])assert.equal((await db.query('SELECT status FROM jobs WHERE id=$1',[id])).rows[0].status,status);
 assert.deepEqual((await db.query('SELECT status,attempts FROM storage_deletions WHERE storage_key=$1',[activeKey])).rows[0],{status:'running',attempts:5});
 assert.deepEqual((await db.query('SELECT status,attempts FROM storage_deletions WHERE storage_key=$1',[retryKey])).rows[0],{status:'accepted',attempts:5});
});
test('Migrations are repeatable with foreign keys and checks enforced',async()=>{await assert.rejects(db.query("INSERT INTO sessions VALUES('invalid',$1,'csrf',now(),now())",[randomUUID()]));await assert.rejects(db.query("INSERT INTO enquiries(id,category,name,email,message,locale) VALUES($1,'bad','Test','test@example.test','Invalid','en')",[randomUUID()]));});
test('Visitor enquiry persists, business admin retrieves and updates, audit is stored',async()=>{const r=await app.inject({method:'POST',url:'/api/v1/public/enquiries',payload:{category:'partnership',name:'Test visitor',email:'visitor@example.test',organization:'Test organization',message:'Integration workflow enquiry',locale:'de',consent:true}});assert.equal(r.statusCode,201,r.body);const id=r.json().id;const list=await app.inject({method:'GET',url:'/api/v1/admin/enquiries?category=partnership&search=Test&page=1&limit=1',headers:businessH});assert.equal(list.statusCode,200,list.body);assert.equal(list.json().items[0].id,id);const change=await app.inject({method:'PATCH',url:'/api/v1/admin/enquiries/'+id,headers:businessH,payload:{status:'active',notes:'Arrange follow-up',ownerId:business.id,followUpAt:null}});assert.equal(change.statusCode,200,change.body);assert.equal((await db.query('SELECT status FROM enquiries WHERE id=$1',[id])).rows[0].status,'active');assert.equal((await db.query("SELECT count(*) FROM audit WHERE record_id=$1 AND action='enquiry.updated'",[id])).rows[0].count,'1');const job=(await db.query("SELECT status FROM jobs WHERE dedupe_key=$1",['enquiry:'+id])).rows[0];assert.equal(job.status,'pending');});
test('Unauthorized, wrong-role and CSRF requests are denied',async()=>{assert.equal((await app.inject({url:'/api/v1/admin/enquiries'})).statusCode,401);assert.equal((await app.inject({url:'/api/v1/admin/enquiries',headers:viewerH})).statusCode,403);assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/content',headers:{cookie:ownerH.cookie},payload:article})).statusCode,403);assert.equal((await app.inject({method:'POST',url:'/api/v1/public/enquiries',headers:{origin:'https://evil.example'},payload:{}})).statusCode,403);});
test('Editor creates private draft, cannot publish; publisher publishes; revision retained',async()=>{const created=await app.inject({method:'POST',url:'/api/v1/admin/content',headers:editorH,payload:article});assert.equal(created.statusCode,201,created.body);articleId=created.json().id;const url='/api/v1/public/content/article/en/'+article.slug;assert.equal((await app.inject({url})).statusCode,404);const denied=await app.inject({method:'PATCH',url:'/api/v1/admin/content/'+articleId,headers:editorH,payload:{...article,revision:1,state:'published'}});assert.equal(denied.statusCode,403);const approved=await app.inject({method:'POST',url:'/api/v1/admin/content/'+articleId+'/review',headers:ownerH,payload:{expectedRevision:1,verdict:'approved',note:'Synthetic article approval only.'}});assert.equal(approved.statusCode,200,approved.body);const published=await app.inject({method:'PATCH',url:'/api/v1/admin/content/'+articleId,headers:ownerH,payload:{...article,revision:2,state:'published'}});assert.equal(published.statusCode,200,published.body);assert.equal((await app.inject({url})).json().title,article.title);assert.equal((await db.query('SELECT count(*) FROM revisions WHERE content_id=$1',[articleId])).rows[0].count,'3');const stale=await app.inject({method:'PATCH',url:'/api/v1/admin/content/'+articleId,headers:ownerH,payload:{...article,revision:1}});assert.equal(stale.statusCode,409);});
test('Draft restoration, archive and category contracts work',async()=>{const revisions=await app.inject({url:`/api/v1/admin/content/${articleId}/revisions`,headers:ownerH});const restored=await app.inject({method:'POST',url:`/api/v1/admin/content/${articleId}/restore`,headers:ownerH,payload:{revisionId:revisions.json().items[1].id,currentRevision:3}});assert.equal(restored.statusCode,200,restored.body);assert.equal(restored.json().state,'draft');assert.equal((await app.inject({url:'/api/v1/public/content/article/en/'+article.slug})).statusCode,200);const archive=await app.inject({method:'DELETE',url:'/api/v1/admin/content/'+articleId,headers:ownerH,payload:{}});assert.equal(archive.statusCode,200);});
test('Applicant CV is quarantined and private, HR can review, other roles denied',async()=>{const vacancy={kind:'job',slug:'test-engineer',locale:'en',title:'Test vacancy',body:'Test fixture',state:'draft'};const job=await app.inject({method:'POST',url:'/api/v1/admin/content',headers:ownerH,payload:vacancy});assert.equal(job.statusCode,201,job.body);jobId=job.json().id;assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/content/'+jobId+'/review',headers:ownerH,payload:{expectedRevision:1,verdict:'approved',note:'Synthetic vacancy approval only.'}})).statusCode,200);assert.equal((await app.inject({method:'PATCH',url:'/api/v1/admin/content/'+jobId,headers:ownerH,payload:{...vacancy,revision:2,state:'published'}})).statusCode,200);const bytes=await generatePDF('Test CV','Test fixture, no real applicant');const r=await app.inject({method:'POST',url:'/api/v1/public/applications',payload:{jobId,name:'Test applicant',email:'applicant@example.test',message:'Test application',filename:'cv.pdf',base64:bytes.toString('base64'),consent:true}});assert.equal(r.statusCode,201,r.body);assert.equal(r.json().fileStatus,'quarantine');applicationId=r.json().id;const listed=await app.inject({url:'/api/v1/admin/applications',headers:hrH});assert.equal(listed.statusCode,200,listed.body);fileId=listed.json().items[0].file_id;const cvMeta=await app.inject({url:'/api/v1/admin/files/'+fileId,headers:hrH});assert.equal(cvMeta.statusCode,200,cvMeta.body);assert.equal(cvMeta.json().scan_status,'quarantine');assert.ok(!('storage_key' in cvMeta.json()));assert.equal((await app.inject({url:'/api/v1/admin/files/'+fileId,headers:businessH})).statusCode,403);assert.equal((await app.inject({url:'/api/v1/admin/applications',headers:businessH})).statusCode,403);assert.equal((await app.inject({url:`/api/v1/public/files/${fileId}/download`})).statusCode,404);assert.equal((await app.inject({url:`/api/v1/admin/files/${fileId}/download`,headers:hrH})).statusCode,409);assert.equal((await app.inject({url:`/api/v1/admin/files/${fileId}/download`,headers:businessH})).statusCode,403);assert.equal((await app.inject({url:`/api/v1/admin/files/${fileId}/download`})).statusCode,401);});
test('A verified clean CV is downloadable only by HR/owner; retention deletion removes file',async()=>{await db.query("UPDATE files SET scan_status='clean' WHERE id=$1",[fileId]);const r=await app.inject({url:`/api/v1/admin/files/${fileId}/download`,headers:hrH});assert.equal(r.statusCode,200,r.body);assert.equal(r.rawPayload.subarray(0,5).toString(),'%PDF-');const update=await app.inject({method:'PATCH',url:'/api/v1/admin/applications/'+applicationId,headers:hrH,payload:{status:'review',notes:'Reviewed'}});assert.equal(update.statusCode,200,update.body);const invalid=await app.inject({method:'PATCH',url:'/api/v1/admin/applications/'+applicationId,headers:hrH,payload:{status:'hired',notes:''}});assert.equal(invalid.statusCode,409);const deleted=await app.inject({method:'DELETE',url:'/api/v1/admin/applications/'+applicationId,headers:hrH,payload:{}});assert.equal(deleted.statusCode,200,deleted.body);assert.equal((await db.query('SELECT id FROM files WHERE id=$1',[fileId])).rowCount,0);});
test('Template PDF generation, approval, public delivery and restrictions work',async()=>{const r=await app.inject({method:'POST',url:'/api/v1/admin/templates/company-profile/generate',headers:ownerH,payload:{classification:'internal'}});assert.equal(r.statusCode,201,r.body);generatedId=r.json().id;const download=await app.inject({url:`/api/v1/admin/files/${generatedId}/download`,headers:businessH});assert.equal(download.statusCode,200,download.body);assert.equal((await app.inject({url:`/api/v1/public/files/${generatedId}/download`})).statusCode,404);const approved=await app.inject({method:'PATCH',url:`/api/v1/admin/files/${generatedId}`,headers:ownerH,payload:{title:'Test company profile',classification:'public',approval:'approved',reviewAt:null,archived:false}});assert.equal(approved.statusCode,200,approved.body);const publicDownload=await app.inject({url:`/api/v1/public/files/${generatedId}/download`});assert.equal(publicDownload.statusCode,200,publicDownload.body);assert.equal(publicDownload.rawPayload.subarray(0,5).toString(),'%PDF-');});
test('Unsafe upload and malicious filenames are rejected; quarantine cannot be approved',async()=>{const bad=await app.inject({method:'POST',url:'/api/v1/admin/files',headers:ownerH,payload:{filename:'../../bad.pdf',base64:Buffer.from('not PDF data').toString('base64'),title:'Bad'}});assert.equal(bad.statusCode,400);const bytes=await generatePDF('Draft','Test');const r=await app.inject({method:'POST',url:'/api/v1/admin/files',headers:businessH,payload:{filename:'draft.pdf',base64:bytes.toString('base64'),title:'Draft',classification:'internal'}});assert.equal(r.statusCode,201,r.body);const approve=await app.inject({method:'PATCH',url:`/api/v1/admin/files/${r.json().id}`,headers:ownerH,payload:{title:'Draft',classification:'public',approval:'approved',reviewAt:null,archived:false}});assert.equal(approve.statusCode,409);});
test('Account enrollment requires password, recovery codes are hashed and single-use',async()=>{const email='new-user@example.test';const created=await app.inject({method:'POST',url:'/api/v1/admin/users',headers:ownerH,payload:{email,password,role:'viewer'}});assert.equal(created.statusCode,201,created.body);assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/mfa/enroll',payload:{email,password:'incorrect'}})).statusCode,403);const start=await app.inject({method:'POST',url:'/api/v1/auth/mfa/enroll',payload:{email,password}});assert.equal(start.statusCode,200,start.body);const enrolled=await app.inject({method:'POST',url:'/api/v1/auth/mfa/verify',payload:{challenge:start.json().challenge,code:totp(start.json().secret)}});assert.equal(enrolled.statusCode,200,enrolled.body);const code=enrolled.json().recoveryCodes[0];assert.equal((await db.query('SELECT code_hash FROM mfa_recovery WHERE user_id=$1',[created.json().id])).rows.some(r=>r.code_hash===code),false);const successful=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email,password,code}});assert.equal(successful.statusCode,200,successful.body);assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email,password,code}})).statusCode,401);assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/mfa/enroll',payload:{email,password}})).statusCode,403);});
test('Remember browser is opt-in, survives renewal, and cannot bypass MFA, expiry or revocation',async()=>{
 for(const rememberBrowser of [false,true]){
  const user=await account('viewer'),code=randomUUID();
  const remoteAddress=`2001:db8:${user.id.slice(0,4)}:${user.id.slice(4,8)}::2`;
  await db.query('INSERT INTO mfa_recovery VALUES($1,$2)',[user.id,hash(code)]);
  const payload={email:user.email,password,code,rememberBrowser};
  const bad=await app.inject({method:'POST',url:'/api/v1/auth/login',remoteAddress,payload:{...payload,code:'000000'}});
  assert.equal(bad.statusCode,401);assert.equal(bad.cookies.length,0);
  const signed=await app.inject({method:'POST',url:'/api/v1/auth/login',remoteAddress,payload});
  assert.equal(signed.statusCode,200,signed.body);
  const cookie=signed.cookies.find(c=>c.name==='onesa_session')!;
  assert.ok(cookie.httpOnly);assert.equal(cookie.sameSite,'Strict');assert.equal(cookie.path,'/');assert.equal(cookie.domain,undefined);
  assert.equal(cookie.maxAge,rememberBrowser?28800:undefined);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/login',remoteAddress,payload})).statusCode,401,'remember does not permit factor replay');
  const h={cookie:signed.cookies.filter(c=>c.value).map(c=>c.name+'='+c.value).join('; '),'x-csrf-token':signed.json().csrf,origin:process.env.PUBLIC_ORIGIN||'http://localhost:3300'};
  await db.query("UPDATE sessions SET created_at=now()-interval '5 minutes' WHERE user_id=$1",[user.id]);
  const previous=(await db.query('SELECT created_at,expires_at FROM sessions WHERE user_id=$1',[user.id])).rows[0];
  assert.ok(new Date(previous.expires_at).getTime()-Date.now()<=28800_000);
  const renewed=await app.inject({method:'POST',url:'/api/v1/auth/renew',headers:h,payload:{}});
  assert.equal(renewed.statusCode,200,renewed.body);
  assert.equal(renewed.cookies.find(c=>c.name==='onesa_session')?.maxAge,rememberBrowser?28800:undefined);
  assert.equal((await db.query('SELECT created_at FROM sessions WHERE user_id=$1',[user.id])).rows[0].created_at.getTime(),previous.created_at.getTime(),'renewal is not fresh MFA');
  assert.equal((await app.inject({url:'/api/v1/auth/me',headers:h})).statusCode,401,'rotation invalidates old bearer');
  const next={...h,cookie:renewed.cookies.filter(c=>c.value).map(c=>c.name+'='+c.value).join('; '),'x-csrf-token':renewed.json().csrf};
  assert.equal((await app.inject({url:'/api/v1/auth/me',headers:next})).statusCode,200);
  await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",[user.id]);
  assert.equal((await app.inject({url:'/api/v1/auth/me',headers:next})).statusCode,401);
  // Preference alone is never authentication.
  assert.equal((await app.inject({url:'/api/v1/auth/me',headers:{cookie:'onesa_remember_browser=1'}})).statusCode,401);
  const freshCode=randomUUID();await db.query('INSERT INTO mfa_recovery VALUES($1,$2)',[user.id,hash(freshCode)]);
  const fresh=await app.inject({method:'POST',url:'/api/v1/auth/login',remoteAddress,payload:{...payload,code:freshCode}});
  assert.equal(fresh.statusCode,200,fresh.body);
  const out=await app.inject({method:'POST',url:rememberBrowser?'/api/v1/auth/revoke':'/api/v1/auth/logout',headers:{...h,cookie:fresh.cookies.filter(c=>c.value).map(c=>c.name+'='+c.value).join('; '),'x-csrf-token':fresh.json().csrf},payload:{}});
  assert.equal(out.statusCode,200,out.body);
  for(const name of ['onesa_session','onesa_remember_browser'])assert.equal(out.cookies.find(c=>c.name===name)?.value,'');
  assert.equal((await app.inject({url:'/api/v1/auth/me',headers:{cookie:'onesa_session='+fresh.cookies.find(c=>c.name==='onesa_session')!.value}})).statusCode,401);
 }
});
test('MFA replay, session revocation, expiry and privilege escalation are rejected',async()=>{const u=await account('viewer');const code=totp(secret);const first=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:u.email,password,code}});assert.equal(first.statusCode,200,first.body);assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:u.email,password,code}})).statusCode,401);const h={cookie:first.cookies[0].name+'='+first.cookies[0].value,'x-csrf-token':first.json().csrf,origin:process.env.PUBLIC_ORIGIN||'http://localhost:3300'};assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/revoke',headers:h,payload:{}})).statusCode,200);assert.equal((await app.inject({url:'/api/v1/auth/me',headers:h})).statusCode,401);const admin=await account('administrator'),adminH=await login(admin);assert.equal((await app.inject({method:'PATCH',url:'/api/v1/admin/users/'+viewer.id,headers:adminH,payload:{role:'owner',disabled:false}})).statusCode,403);await db.query('UPDATE sessions SET expires_at=now()-interval \'1 minute\' WHERE user_id=$1',[viewer.id]);assert.equal((await app.inject({url:'/api/v1/auth/me',headers:viewerH})).statusCode,401);});
test('Fact keys with underscores save, public fields are minimal and production legal gate blocks release',async()=>{const value=await app.inject({method:'PUT',url:'/api/v1/admin/facts/register_number',headers:ownerH,payload:{value:'HRB 757830',status:'supplied',source:'User directive; official registry review pending'}});assert.equal(value.statusCode,200,value.body);const docs=await app.inject({url:'/api/v1/public/files'});assert.ok(!JSON.stringify(docs.json()).includes('owner_id'));assert.ok(!JSON.stringify(docs.json()).includes('association'));const {env}=await import('../src/config/env.js');env.NODE_ENV='production';try{assert.equal((await app.inject({url:'/api/v1/public/content'})).statusCode,409);assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/content',headers:ownerH,payload:{...article,slug:'production-blocked',state:'published'}})).statusCode,409);}finally{env.NODE_ENV='test';}});
test('Empty pagination pages preserve total counts',async()=>{const r=await app.inject({url:'/api/v1/admin/templates?page=100&limit=1',headers:ownerH});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().items.length,0);assert.ok(r.json().total>=36);});
test('Request schemas, rate limits and audit records do not expose secrets',async()=>{assert.equal((await app.inject({url:'/api/v1/public/content?page=-1'})).statusCode,400);await db.query("INSERT INTO rate_limits VALUES('login:127.0.0.1',100,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET hits=100,expires_at=now()+interval '15 minutes'");const r=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:owner.email,password,code:'000000'}});assert.equal(r.statusCode,429,r.body);const logged=JSON.stringify((await db.query('SELECT * FROM audit')).rows);assert.ok(!logged.includes(password));assert.ok(!logged.includes(secret));assert.ok(!logged.includes(ownerH.cookie));const publicData=await app.inject({url:'/api/v1/public/company'});assert.equal(publicData.json().release_ready,false);assert.equal(publicData.json().facts.length,0);});

test('Editorial approval binds exact revisions, rejects forgery and stale review, and schedules publication once',async()=>{
 const future=new Date(Date.now()+86400000).toISOString(),draft={...article,slug:'scheduled-review-fixture',publishAt:null};
 const forged=await app.inject({method:'POST',url:'/api/v1/admin/content',headers:ownerH,payload:{...draft,metadata:{editorialReview:{status:'approved'}}}});assert.equal(forged.statusCode,400);
 const created=await app.inject({method:'POST',url:'/api/v1/admin/content',headers:ownerH,payload:draft});assert.equal(created.statusCode,201,created.body);const id=created.json().id,url='/api/v1/public/content/article/en/'+draft.slug;
 const early=await app.inject({method:'PATCH',url:'/api/v1/admin/content/'+id,headers:ownerH,payload:{...draft,revision:1,state:'published'}});assert.equal(early.statusCode,409);assert.equal(early.json().error.code,'EDITORIAL_REVIEW');
 assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/content/'+id+'/review',headers:editorH,payload:{expectedRevision:1,verdict:'approved',note:'Synthetic forbidden approval.'}})).statusCode,403);
 const queued=await app.inject({method:'POST',url:'/api/v1/admin/content/'+id+'/review',headers:editorH,payload:{expectedRevision:1,verdict:'pending_review',note:'Synthetic editorial review request.'}});assert.equal(queued.statusCode,200);
 assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/content/'+id+'/review',headers:ownerH,payload:{expectedRevision:1,verdict:'approved',note:'Synthetic stale approval.'}})).statusCode,409);
 const approved=await app.inject({method:'POST',url:'/api/v1/admin/content/'+id+'/review',headers:ownerH,payload:{expectedRevision:2,verdict:'approved',note:'Synthetic reviewed schedule.'}});assert.equal(approved.statusCode,200,approved.body);
 const scheduled=await app.inject({method:'PATCH',url:'/api/v1/admin/content/'+id,headers:ownerH,payload:{...draft,publishAt:future,revision:3,state:'published'}});assert.equal(scheduled.statusCode,200,scheduled.body);assert.equal(scheduled.json().state,'draft');
 const {tick}=await import('../src/jobs/worker.js');await tick();assert.equal((await app.inject({url})).statusCode,404);
 await db.query("UPDATE content SET publish_at=now()-interval '1 second' WHERE id=$1",[id]);await tick();await tick();
 const published=await app.inject({url});assert.equal(published.statusCode,200,published.body);assert.equal('editorialReview' in published.json().metadata,false);assert.ok(published.json().metadata.publishedAt);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM audit WHERE record_id=$1 AND action='content.scheduled_publish'",[id])).rows[0].n,1);
 const changed=await app.inject({method:'PATCH',url:'/api/v1/admin/content/'+id,headers:ownerH,payload:{...draft,revision:5,body:'Changed unreviewed synthetic text.',publishAt:null,state:'published'}});assert.equal(changed.statusCode,409);
 const unpublish=await app.inject({method:'POST',url:'/api/v1/admin/content/'+id+'/unpublish',headers:ownerH,payload:{expectedRevision:5}});assert.equal(unpublish.statusCode,200,unpublish.body);assert.equal((await app.inject({url})).statusCode,404);
});
test('Future published legacy rows stay private on lists, detail, categories and vacancy intake',async()=>{
 const ids=[randomUUID(),randomUUID()];
 await db.query("INSERT INTO content(id,kind,slug,locale,title,body,metadata,state,publish_at) VALUES($1,'article','future-legacy-fixture','en','Future synthetic fixture','Synthetic only','{\"category\":\"FutureOnlyCategory\"}','published',now()+interval '1 day'),($2,'job','future-vacancy-fixture','en','Future synthetic vacancy','Synthetic only','{}','published',now()+interval '1 day')",ids);
 assert.equal((await app.inject({url:'/api/v1/public/content/article/en/future-legacy-fixture'})).statusCode,404);
 const listing=await app.inject({url:'/api/v1/public/content?search=Future%20synthetic'});assert.equal(listing.statusCode,200);assert.equal(listing.json().total,0);
 const categories=await app.inject({url:'/api/v1/public/categories'});assert.ok(!categories.json().items.includes('FutureOnlyCategory'));
 const bytes=await generatePDF('Synthetic future CV','No real applicant content');const denied=await app.inject({method:'POST',url:'/api/v1/public/applications',payload:{jobId:ids[1],name:'Synthetic future applicant',email:'future@example.invalid',filename:'future.pdf',base64:bytes.toString('base64'),consent:true}});assert.equal(denied.statusCode,404,denied.body);
 const legacy=randomUUID();await db.query("INSERT INTO content(id,kind,slug,locale,title,body,state) VALUES($1,'article','previously-published-fixture','en','Existing approved content fixture','Synthetic existing content','published')",[legacy]);assert.equal((await app.inject({url:'/api/v1/public/content/article/en/previously-published-fixture'})).statusCode,200);
});
test('Background processing is protected, bounded and redacts job payloads and arbitrary error content',async()=>{
 const id=randomUUID();await db.query("INSERT INTO jobs(id,kind,dedupe_key,payload,status,last_error) VALUES($1,'email',$2,$3,'failed',$4)",[id,'private-fixture:'+id,{to:'private-recipient@example.invalid',text:'private-content-never-returned'},'provider raw-private-error secret=synthetic-private-marker']);
 for(const path of ['/api/v1/admin/processing/overview','/api/v1/admin/processing/jobs']){assert.equal((await app.inject({url:path})).statusCode,401);assert.equal((await app.inject({url:path,headers:editorH})).statusCode,403);const result=await app.inject({url:path,headers:ownerH});assert.equal(result.statusCode,200,result.body);assert.match(String(result.headers['cache-control']),/no-store/);for(const marker of ['private-recipient','private-content','raw-private-error','synthetic-private-marker'])assert.ok(!result.body.includes(marker));}
 const list=await app.inject({url:'/api/v1/admin/processing/jobs?status=failed',headers:ownerH});assert.ok(list.json().items.some((row:{id:string;errorCategory:string})=>row.id===id&&row.errorCategory==='unclassified'));
 assert.equal((await app.inject({url:'/api/v1/admin/processing/jobs?limit=51',headers:ownerH})).statusCode,400);
 const outOfRange=await app.inject({url:'/api/v1/admin/processing/jobs?page=10000&limit=1',headers:ownerH});assert.equal(outOfRange.json().items.length,0);assert.ok(outOfRange.json().total>0);
});
test('Editorial image approval rejects private or unscanned media and missing rights/alt metadata',async()=>{
 const image=randomUUID();await db.query("INSERT INTO files(id,filename,mime,size,storage_key,sha256,classification,scan_status,title,approval) VALUES($1::uuid,'synthetic.png','image/png',8,($1::uuid)::text,'synthetic','internal','quarantine','Synthetic image fixture','pending')",[image]);
 const draft={...article,slug:'media-review-fixture',metadata:{imageId:image,imageAlt:'Synthetic image only',imageRights:'Original synthetic test fixture'}};
 const created=await app.inject({method:'POST',url:'/api/v1/admin/content',headers:ownerH,payload:draft});assert.equal(created.statusCode,201);const id=created.json().id;
 const review={expectedRevision:1,verdict:'approved',note:'Synthetic media approval only.'};assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/content/'+id+'/review',headers:ownerH,payload:review})).statusCode,409);
 await db.query("UPDATE files SET classification='public',scan_status='clean',approval='approved' WHERE id=$1",[image]);
 const missing=await app.inject({method:'PATCH',url:'/api/v1/admin/content/'+id,headers:ownerH,payload:{...draft,revision:1,metadata:{imageId:image}}});assert.equal(missing.statusCode,200);
 assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/content/'+id+'/review',headers:ownerH,payload:{...review,expectedRevision:2}})).statusCode,409);
 const complete=await app.inject({method:'PATCH',url:'/api/v1/admin/content/'+id,headers:ownerH,payload:{...draft,revision:2}});assert.equal(complete.statusCode,200);
 const approved=await app.inject({method:'POST',url:'/api/v1/admin/content/'+id+'/review',headers:ownerH,payload:{...review,expectedRevision:3}});assert.equal(approved.statusCode,200,approved.body);
});


test('Cookie mutations reject missing Origin and public facts omit reviewer/source',async()=>{
 const {origin,...missingOrigin}=ownerH;
 assert.ok(origin);
 const denied=await app.inject({method:'POST',url:'/api/v1/auth/renew',headers:missingOrigin,payload:{}});
 assert.equal(denied.statusCode,403);
 await db.query("INSERT INTO facts(key,value,status,source,verified_by) VALUES('founder','Andrew Gotora','verified','Internal reviewer-only note',$1) ON CONFLICT(key) DO UPDATE SET status='verified',source='Internal reviewer-only note',verified_by=$1",[owner.id]);
 const response=await app.inject({url:'/api/v1/public/company'});
 assert.equal(response.statusCode,200);
 const facts=response.json().facts;
 assert.ok(facts.some((fact:{key:string})=>fact.key==='founder'));
 assert.ok(!JSON.stringify(facts).includes('verified_by'));
 assert.ok(!JSON.stringify(facts).includes('Internal reviewer-only note'));
});


test('Storage cleanup survives worker interruption and rolls back with metadata',async()=>{
 const {transaction}=await import('../src/services/db.js');
 const {enqueueStorageDeletion}=await import('../src/services/workflows.js');
 const {store,retrieve}=await import('../src/services/storage.js');
 const {tick}=await import('../src/jobs/worker.js');
 const key=randomUUID();await store(key,Buffer.from('synthetic retention fixture'));
 await assert.rejects(transaction(async c=>{await enqueueStorageDeletion(c,key);throw new Error('rollback fixture');}));
 assert.equal((await db.query('SELECT * FROM storage_deletions WHERE storage_key=$1',[key])).rowCount,0);
 assert.equal((await retrieve(key)).toString(),'synthetic retention fixture');
 await transaction(c=>enqueueStorageDeletion(c,key));
 await db.query("UPDATE storage_deletions SET status='running',locked_at=now()-interval '10 minutes' WHERE storage_key=$1",[key]);
 await tick();await tick();
 await assert.rejects(retrieve(key),{code:'ENOENT'});
 assert.equal((await db.query('SELECT status FROM storage_deletions WHERE storage_key=$1',[key])).rows[0].status,'accepted');
});

test('Sensitive user changes require fresh credentials and atomically revoke target access',async()=>{
 const actor=await account('owner'),headers=await login(actor),target=await account('viewer'),targetH=await login(target);
 const url='/api/v1/admin/users/'+target.id,payload={role:'viewer',disabled:true,resetMfa:true};
 const missing=await app.inject({method:'PATCH',url,headers,payload});
 assert.equal(missing.statusCode,403);assert.equal(missing.json().error.code,'STEP_UP_REQUIRED');
 assert.equal((await app.inject({url:'/api/v1/auth/me',headers:targetH})).statusCode,200);
 const recovery=randomUUID();await db.query('INSERT INTO mfa_recovery VALUES($1,$2)',[actor.id,hash(recovery)]);
 const wrong=await app.inject({method:'PATCH',url,headers,payload:{...payload,stepUp:{password:'incorrect',code:recovery}}});
 assert.equal(wrong.statusCode,403);
 assert.equal((await db.query('SELECT code_hash FROM mfa_recovery WHERE user_id=$1 AND code_hash=$2',[actor.id,hash(recovery)])).rowCount,1);
 const changed=await app.inject({method:'PATCH',url,headers,payload:{...payload,stepUp:{password,code:recovery}}});
 assert.equal(changed.statusCode,200,changed.body);assert.equal(changed.json().disabled,true);
 assert.equal((await app.inject({url:'/api/v1/auth/me',headers:targetH})).statusCode,401);
 assert.equal((await db.query('SELECT mfa_secret FROM users WHERE id=$1',[target.id])).rows[0].mfa_secret,null);
 assert.equal((await db.query('SELECT code_hash FROM mfa_recovery WHERE user_id=$1',[target.id])).rowCount,0);
 const logged=JSON.stringify((await db.query('SELECT action FROM audit WHERE actor_id=$1 AND record_id=$2',[actor.id,target.id])).rows);
 assert.ok(logged.includes('auth.step_up'));assert.ok(logged.includes('user.mfa_reset'));assert.ok(!logged.includes(recovery));
 const reused=await app.inject({method:'PATCH',url,headers,payload:{...payload,stepUp:{password,code:recovery}}});
 assert.equal(reused.statusCode,403);assert.equal(reused.json().error.code,'STEP_UP_FAILED');
});

test('Fresh authenticator codes cannot be replayed for account changes and owners remain protected',async()=>{
 const actor=await account('owner'),headers=await login(actor),target=await account('viewer');
 const payload={role:'hr',disabled:false,stepUp:{password,code:totp(secret)}};
 const changed=await app.inject({method:'PATCH',url:'/api/v1/admin/users/'+target.id,headers,payload});
 assert.equal(changed.statusCode,200,changed.body);
 const replay=await app.inject({method:'PATCH',url:'/api/v1/admin/users/'+target.id,headers,payload});
 assert.equal(replay.statusCode,403);assert.equal(replay.json().error.code,'STEP_UP_FAILED');
 const administrator=await account('administrator'),adminH=await login(administrator),recovery=randomUUID();
 await db.query('INSERT INTO mfa_recovery VALUES($1,$2)',[administrator.id,hash(recovery)]);
 const forbidden=await app.inject({method:'PATCH',url:'/api/v1/admin/users/'+actor.id,headers:adminH,payload:{role:'viewer',disabled:false,stepUp:{password,code:recovery}}});
 assert.equal(forbidden.statusCode,403);
 assert.equal((await db.query('SELECT code_hash FROM mfa_recovery WHERE user_id=$1 AND code_hash=$2',[administrator.id,hash(recovery)])).rowCount,1);
});

test('Concurrent sensitive changes consume a recovery code only once',async()=>{
 const actor=await account('owner'),headers=await login(actor),a=await account('viewer'),b=await account('viewer'),code=randomUUID();
 await db.query('INSERT INTO mfa_recovery VALUES($1,$2)',[actor.id,hash(code)]);
 const payload={role:'business',disabled:false,stepUp:{password,code}};
 const responses=await Promise.all([a,b].map(target=>app.inject({method:'PATCH',url:'/api/v1/admin/users/'+target.id,headers,payload})));
 assert.deepEqual(responses.map(r=>r.statusCode).sort(),[200,403]);
 assert.equal(Number((await db.query("SELECT count(*) FROM users WHERE id=ANY($1) AND role='business'",[[a.id,b.id]])).rows[0].count),1);
});

test('Own password change requires fresh proof and revokes every session without removing MFA',async()=>{
 const actor=await account('viewer'),headers=await login(actor),otherHeaders=await login(actor),code=randomUUID(),url='/api/v1/auth/password/change',newPassword='changed-private-password-45678';
 await db.query('INSERT INTO mfa_recovery VALUES($1,$2)',[actor.id,hash(code)]);
 assert.equal((await app.inject({method:'POST',url,headers,payload:{password:newPassword,stepUp:{password:'incorrect',code}}})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url,headers,payload:{password:newPassword}})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url,headers:{...headers,origin:'https://untrusted.example'},payload:{password:newPassword,stepUp:{password,code}}})).statusCode,403);
 assert.equal((await db.query('SELECT code_hash FROM mfa_recovery WHERE user_id=$1 AND code_hash=$2',[actor.id,hash(code)])).rowCount,1);
 const changed=await app.inject({method:'POST',url,headers,payload:{password:newPassword,stepUp:{password,code}}});
 assert.equal(changed.statusCode,200,changed.body);
 assert.equal((await app.inject({url:'/api/v1/auth/me',headers})).statusCode,401);
 assert.equal((await app.inject({url:'/api/v1/auth/me',headers:otherHeaders})).statusCode,401);
 assert.ok((await db.query('SELECT mfa_secret FROM users WHERE id=$1',[actor.id])).rows[0].mfa_secret);
 const newCode=randomUUID();await db.query('INSERT INTO mfa_recovery VALUES($1,$2)',[actor.id,hash(newCode)]);
 const attempt={method:'POST' as const,url:'/api/v1/auth/login',remoteAddress:`2001:db8:${actor.id.slice(0,4)}:${actor.id.slice(4,8)}::1`,payload:{email:actor.email,password,code:newCode}};
 assert.equal((await app.inject(attempt)).statusCode,401);
 assert.equal((await app.inject({...attempt,payload:{...attempt.payload,password:newPassword}})).statusCode,200);
 const logged=JSON.stringify((await db.query("SELECT action FROM audit WHERE actor_id=$1",[actor.id])).rows);
 assert.ok(logged.includes('auth.password_changed'));assert.ok(!logged.includes(newPassword));
});

test('Company origin may submit public enquiries but cannot perform portal authentication',async()=>{
 const blocked=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://company.example.invalid'},payload:{email:'nobody@example.invalid',password:'synthetic-password',code:'000000'}});
 assert.equal(blocked.statusCode,403);assert.equal(blocked.json().error.code,'ORIGIN');
 const allowed=await app.inject({method:'POST',url:'/api/v1/public/enquiries',headers:{origin:'http://company.example.invalid'},payload:{}});
 // Validation follows the origin gate, proving this exact public origin is accepted.
 assert.equal(allowed.statusCode,400);assert.equal(allowed.json().error.code,'VALIDATION');
 const lookalike=await app.inject({method:'POST',url:'/api/v1/public/enquiries',headers:{origin:'http://company.example.invalid.attacker.invalid'},payload:{}});
 assert.equal(lookalike.statusCode,403);
 const alternate=await app.inject({method:'POST',url:'/api/v1/admin/settings/legal',headers:{origin:'http://company.example.invalid'},payload:{}});
 assert.equal(alternate.statusCode,403);
});

async function transferred(payload:unknown,headers:Record<string,string>,scope='admin'){
 const {createHash}=await import('node:crypto');const bytes=Buffer.from(JSON.stringify(payload));
 const prefix=`/api/v1/${scope}/transfers`;
 const start=await app.inject({method:'POST',url:prefix,headers,payload:{size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}});assert.equal(start.statusCode,201);const receipt=start.json();
 for(let offset=0,sequence=0;offset<bytes.length;offset+=512*1024,sequence++){
  const body={ticket:receipt.ticket,sequence,base64:bytes.subarray(offset,offset+512*1024).toString('base64')};const chunk=await app.inject({method:'POST',url:`${prefix}/${receipt.id}/chunks`,headers,payload:body});assert.equal(chunk.statusCode,200);
  if(sequence===0){const duplicate=await app.inject({method:'POST',url:`${prefix}/${receipt.id}/chunks`,headers,payload:body});assert.deepEqual(duplicate.json(),chunk.json());}
 }
 return {prefix,receipt,finish:()=>app.inject({method:'POST',url:`${prefix}/${receipt.id}/complete`,headers,payload:{ticket:receipt.ticket}})};
}

test('Bounded durable uploads preserve below/at/above 10 MiB limits and one-use finalization',async()=>{
 const actor=await account('owner'),headers=await login(actor),deniedHeaders=await login(await account('viewer'));const pdf=await generatePDF('Synthetic','Transfer fixture');
 for(const size of [10485759,10485760,10485761]){
  const bytes=Buffer.concat([pdf.subarray(0,-6),Buffer.alloc(size-pdf.length,32),pdf.subarray(-6)]);
  const transfer=await transferred({filename:'bounded.pdf',title:'Bounded fixture',base64:bytes.toString('base64'),classification:'internal'},headers);
  const responses=await Promise.all([transfer.finish(),transfer.finish()]);assert.equal(responses[0].statusCode,200);assert.deepEqual(responses[0].json(),responses[1].json());
  const output=responses[0].json();assert.equal(output.status,size>10485760?400:201);
  assert.equal(Number((await db.query('SELECT count(*) FROM bounded_transfer_chunks WHERE transfer_id=$1',[transfer.receipt.id])).rows[0].count),0);
  if(output.status===201){const file=output.body;assert.equal(file.size,size);assert.equal(Number((await db.query('SELECT count(*) FROM files WHERE id=$1',[file.id])).rows[0].count),1);
   assert.equal((await app.inject({url:`/api/v1/admin/files/${file.id}/chunks/0`,headers:deniedHeaders})).statusCode,403);
   assert.equal((await app.inject({url:`/api/v1/public/files/${file.id}/chunks/0`})).statusCode,404);
   await db.query("UPDATE files SET scan_status='clean' WHERE id=$1",[file.id]);const downloaded=[];
   for(let index=0;index*1048576<size;index++){const chunk=await app.inject({url:`/api/v1/admin/files/${file.id}/chunks/${index}`,headers});assert.equal(chunk.statusCode,200);assert.ok(chunk.rawPayload.length<=1048576);assert.equal(Number(chunk.headers['x-file-size']),size);downloaded.push(chunk.rawPayload);}
   assert.deepEqual(Buffer.concat(downloaded),bytes);
  }
 }
});

test('Transfer cancellation, expiry, owner binding, checksum and interrupted chunks are enforced',async()=>{
 const actor=await account('owner'),headers=await login(actor),other=await login(await account('owner'));
 const start=await app.inject({method:'POST',url:'/api/v1/admin/transfers',headers,payload:{size:512*1024+1,sha256:'0'.repeat(64)}});assert.equal(start.statusCode,201);const r=start.json();const payload={ticket:r.ticket};
 assert.equal((await app.inject({method:'POST',url:`/api/v1/admin/transfers/${r.id}/complete`,headers,payload})).statusCode,409);
 assert.equal((await app.inject({method:'POST',url:`/api/v1/admin/transfers/${r.id}/cancel`,headers:other,payload})).statusCode,404);
 assert.equal((await app.inject({method:'POST',url:`/api/v1/admin/transfers/${r.id}/chunks`,headers,payload:{...payload,sequence:1,base64:Buffer.from('x').toString('base64')}})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url:`/api/v1/admin/transfers/${r.id}/cancel`,headers,payload})).statusCode,200);
 assert.equal((await app.inject({method:'POST',url:`/api/v1/admin/transfers/${r.id}/complete`,headers,payload})).statusCode,404);
 const receipt=await transferred({filename:'small.pdf',title:'Small',base64:(await generatePDF('Small','Synthetic')).toString('base64')},headers);
 await db.query('UPDATE bounded_transfers SET expires_at=now()-interval \'1 second\' WHERE id=$1',[receipt.receipt.id]);assert.equal((await receipt.finish()).statusCode,404);
});


test('Shared storage admission enforces exact global/owner ceilings and rolls back rejected files',async()=>{
 const {env}=await import('../src/config/env.js');const {admitFile}=await import('../src/services/workflows.js');const {transaction}=await import('../src/services/db.js');
 const prior={total:env.MAX_FILE_STORAGE_BYTES,owner:env.MAX_OWNER_FILE_STORAGE_BYTES};
 try{
  const total=Number((await db.query('SELECT coalesce(sum(size),0) AS bytes FROM files')).rows[0].bytes);
  const owned=Number((await db.query('SELECT coalesce(sum(size),0) AS bytes FROM files WHERE owner_id=$1',[owner.id])).rows[0].bytes);
  env.MAX_FILE_STORAGE_BYTES=total+100;env.MAX_OWNER_FILE_STORAGE_BYTES=owned+100;
  await transaction(c=>admitFile(c,100,owner.id));
  await assert.rejects(transaction(c=>admitFile(c,101,owner.id)),{code:'STORAGE_QUOTA'});
  env.MAX_FILE_STORAGE_BYTES=prior.total;env.MAX_OWNER_FILE_STORAGE_BYTES=owned;
  await assert.rejects(transaction(c=>admitFile(c,1,owner.id)),{code:'STORAGE_QUOTA'});
 }finally{env.MAX_FILE_STORAGE_BYTES=prior.total;env.MAX_OWNER_FILE_STORAGE_BYTES=prior.owner;}
});

test('Operational metrics reject anonymous/wrong keys and expose bounded non-personal queue state',async()=>{
 const {env}=await import('../src/config/env.js');const old=env.METRICS_TOKEN;env.METRICS_TOKEN='synthetic-metrics-'+ 'x'.repeat(48);
 try{assert.equal((await app.inject({url:'/api/v1/metrics'})).statusCode,403);assert.equal((await app.inject({url:'/api/v1/metrics',headers:{authorization:'Bearer wrong'}})).statusCode,403);
 const response=await app.inject({url:'/api/v1/metrics',headers:{authorization:'Bearer '+env.METRICS_TOKEN}});assert.equal(response.statusCode,200);assert.ok(response.body.includes('onesa_portal_database_available 1'));assert.ok(response.body.includes('onesa_portal_queue_age_seconds'));assert.ok(!response.body.includes(owner.email));assert.ok(!response.body.includes(env.METRICS_TOKEN));assert.ok(!response.body.includes(password));
 }finally{env.METRICS_TOKEN=old;}
});


test('Owner pre-launch mode enables public workflows without approving legal records or exposing drafts/private files',async()=>{
 const {env}=await import('../src/config/env.js');
 const before={node:env.NODE_ENV,stage:env.PUBLICATION_STAGE};
 const legalBefore=(await db.query("SELECT value FROM settings WHERE key='legal'")).rows[0].value;
 const draftId=randomUUID();
 await db.query("INSERT INTO content(id,kind,slug,locale,title,body,state) VALUES($1,'article','prelaunch-private-fixture','en','Private synthetic draft','Not public','draft')",[draftId]);
 try{
  env.NODE_ENV='production';env.PUBLICATION_STAGE='launch';
  assert.equal((await app.inject({url:'/api/v1/public/content'})).statusCode,409);
  env.PUBLICATION_STAGE='prelaunch';
  const company=await app.inject({url:'/api/v1/public/company'});
  assert.equal(company.statusCode,200);assert.equal(company.json().publication_stage,'prelaunch');
  assert.equal(company.json().publication_enabled,true);assert.equal(company.json().release_ready,false);
  const list=await app.inject({url:'/api/v1/public/content?kind=article&locale=en'});
  assert.equal(list.statusCode,200,list.body);assert.ok(!list.json().items.some((item:{id:string})=>item.id===draftId));
  assert.equal((await app.inject({url:'/api/v1/public/content/article/en/prelaunch-private-fixture'})).statusCode,404);
  assert.equal((await app.inject({url:'/api/v1/public/content/article/en/future-legacy-fixture'})).statusCode,404);
  assert.equal((await app.inject({url:'/api/v1/public/categories?locale=en'})).statusCode,200);
  const files=await app.inject({url:'/api/v1/public/files'});assert.equal(files.statusCode,200);
  assert.ok(!JSON.stringify(files.json()).includes('storage_key'));
  for(const path of ['/api/v1/admin/enquiries','/api/v1/admin/applications','/api/v1/admin/settings','/api/v1/admin/governance/records'])assert.equal((await app.inject({url:path})).statusCode,401,path);
  const enquiry=await app.inject({method:'POST',url:'/api/v1/public/enquiries',remoteAddress:'2001:db8:ffaa::1',payload:{category:'general',name:'Synthetic prelaunch visitor',email:'prelaunch@example.invalid',message:'Isolated prelaunch workflow regression only.',locale:'en',consent:true}});
  assert.equal(enquiry.statusCode,201,enquiry.body);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM enquiries WHERE id=$1',[enquiry.json().id])).rows[0].n,1);
  const unreviewed=await app.inject({method:'POST',url:'/api/v1/admin/content',headers:ownerH,payload:{...article,slug:'prelaunch-unreviewed-fixture',state:'published'}});
  assert.equal(unreviewed.statusCode,409);assert.equal(unreviewed.json().error.code,'EDITORIAL_REVIEW');
  assert.deepEqual((await db.query("SELECT value FROM settings WHERE key='legal'")).rows[0].value,legalBefore);
  env.PUBLICATION_STAGE='launch';
  assert.equal((await app.inject({url:'/api/v1/public/content'})).statusCode,409);
  assert.equal((await app.inject({url:'/api/v1/public/company'})).json().publication_enabled,false);
 }finally{env.NODE_ENV=before.node;env.PUBLICATION_STAGE=before.stage;}
});

test('An editor prepares a replacement while the exact approved public edition remains live',async()=>{
 const draft={...article,slug:'replacement-edition-fixture'};
 const create=await app.inject({method:'POST',url:'/api/v1/admin/content',headers:editorH,payload:draft});assert.equal(create.statusCode,201,create.body);
 const id=create.json().id,base='/api/v1/admin/content/'+id,url='/api/v1/public/content/article/en/'+draft.slug;
 const review=async(revision:number,verdict:string,headers=ownerH)=>app.inject({method:'POST',url:base+'/review',headers,payload:{expectedRevision:revision,verdict,note:'Synthetic replacement editorial decision.'}});
 assert.equal((await review(1,'approved')).statusCode,200);
 assert.equal((await app.inject({method:'PATCH',url:base,headers:ownerH,payload:{...draft,state:'published',revision:2}})).statusCode,200);
 const original=(await app.inject({url})).body;
 const replacement={...draft,title:'Replacement awaiting approval',body:'Replacement private text',metadata:{category:'Replacement only'}};
 const saved=await app.inject({method:'PATCH',url:base,headers:editorH,payload:{...replacement,revision:3}});assert.equal(saved.statusCode,200,saved.body);
 assert.equal((await app.inject({url})).body,original);
 assert.equal((await app.inject({url:'/api/v1/public/content?search=Replacement%20private'})).json().total,0);
 assert.ok(!(await app.inject({url:'/api/v1/public/categories'})).json().items.includes('Replacement only'));
 assert.equal((await review(4,'pending_review',editorH)).statusCode,200);
 assert.equal((await review(5,'needs_changes')).statusCode,200);
 assert.equal((await app.inject({url})).body,original);
 assert.equal((await app.inject({method:'PATCH',url:base,headers:editorH,payload:{...replacement,revision:4}})).statusCode,409);
 assert.equal((await app.inject({method:'PATCH',url:base,headers:ownerH,payload:{...replacement,state:'published',revision:6}})).statusCode,409);
 assert.equal((await app.inject({url})).body,original);
 assert.equal((await review(6,'approved')).statusCode,200);
 const publication=await app.inject({method:'PATCH',url:base,headers:ownerH,payload:{...replacement,state:'published',revision:7}});assert.equal(publication.statusCode,200,publication.body);
 assert.equal((await app.inject({url})).json().title,replacement.title);
 assert.equal((await app.inject({url:'/api/v1/public/content/article/de/'+draft.slug})).statusCode,404);
 assert.equal((await app.inject({method:'POST',url:base+'/unpublish',headers:editorH,payload:{expectedRevision:8}})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:base+'/unpublish',headers:ownerH,payload:{expectedRevision:7}})).statusCode,409);
 assert.equal((await app.inject({url})).json().title,replacement.title);
 assert.equal((await app.inject({method:'POST',url:base+'/unpublish',headers:ownerH,payload:{expectedRevision:8}})).statusCode,200);
 assert.equal((await app.inject({url})).statusCode,404);
});

test('Users, templates and audit search on the server and scoped pickers do not expose private records',async()=>{
 for(const [url,search,field,expected] of [['users',owner.email,'email',owner.email],['templates','AbsentSearchMarker','title',null],['audit','enquiry.updated','action','enquiry.updated']] as const){
  const response=await app.inject({url:`/api/v1/admin/${url}?search=${encodeURIComponent(search)}&page=1&limit=1`,headers:ownerH});assert.equal(response.statusCode,200,response.body);
  if(expected){assert.ok(response.json().total>0);assert.equal(response.json().items[0][field],expected);}else assert.equal(response.json().total,0);
  const absent=await app.inject({url:`/api/v1/admin/${url}?search=NoSuchSyntheticResultMarker&page=3&limit=20`,headers:ownerH});assert.equal(absent.json().total,0);assert.deepEqual(absent.json().items,[]);
 }
 const staff=await app.inject({url:'/api/v1/admin/enquiries/assignees?search='+encodeURIComponent(business.email),headers:businessH});assert.equal(staff.statusCode,200,staff.body);assert.deepEqual(staff.json().items,[{id:business.id,email:business.email}]);
 assert.equal((await app.inject({url:'/api/v1/admin/enquiries/assignees?search='+encodeURIComponent(hr.email),headers:businessH})).json().total,0);
 assert.equal((await app.inject({url:'/api/v1/admin/users',headers:businessH})).statusCode,403);
 assert.equal((await app.inject({url:'/api/v1/admin/enquiries/assignees',headers:editorH})).statusCode,403);
 assert.equal((await app.inject({url:'/api/v1/admin/content/media',headers:editorH})).statusCode,200);
 assert.equal((await app.inject({url:'/api/v1/admin/content/media',headers:await login(await account('viewer'))})).statusCode,403);
 const media=(await app.inject({url:'/api/v1/admin/content/media',headers:editorH})).json();
 for(const file of media.items){assert.ok(file.mime.startsWith('image/'));assert.ok(!('storage_key' in file));assert.ok(!('owner_id' in file));const stored=(await db.query('SELECT classification,approval,scan_status,archived FROM files WHERE id=$1',[file.id])).rows[0];assert.deepEqual(stored,{classification:'public',approval:'approved',scan_status:'clean',archived:false});}
});

test('Publication migration preserves existing published editions and excludes drafts',async()=>{
 const connection=await db.connect();await connection.query('BEGIN');
 try{
  await connection.query('DROP VIEW published_content');await connection.query('ALTER TABLE content DROP COLUMN published_snapshot CASCADE');
  const publicId=randomUUID(),privateId=randomUUID();
  await connection.query("INSERT INTO content(id,kind,slug,locale,title,body,state) VALUES($1,'article','migration-approved-fixture','de','Bestehende Meldung','Approved synthetic German edition','published'),($2,'article','migration-private-fixture','de','Privater Entwurf','Private synthetic body','draft')",[publicId,privateId]);
  const before=(await connection.query('SELECT to_jsonb(c) AS snapshot FROM content c WHERE id=$1',[publicId])).rows[0].snapshot;
  const {readFile}=await import('node:fs/promises');await connection.query(await readFile('migrations/012_editorial_publications.sql','utf8'));
  const preserved=(await connection.query('SELECT published_snapshot FROM content WHERE id=$1',[publicId])).rows[0].published_snapshot;assert.deepEqual(preserved,before);
  assert.equal((await connection.query('SELECT title FROM published_content WHERE id=$1',[publicId])).rows[0].title,'Bestehende Meldung');assert.equal((await connection.query('SELECT id FROM published_content WHERE id=$1',[privateId])).rowCount,0);
 }finally{await connection.query('ROLLBACK');connection.release();}
});


test('Scheduled replacement preserves each locale until its approved publication and rollback restores only a draft',async()=>{
 const {publishScheduledContent}=await import('../src/services/editorial.js');const {transaction}=await import('../src/services/db.js');
 for(const locale of ['en','de']){
  const input={...article,slug:'scheduled-replacement-'+locale,locale};const created=await app.inject({method:'POST',url:'/api/v1/admin/content',headers:editorH,payload:input});assert.equal(created.statusCode,201,created.body);const id=created.json().id,base='/api/v1/admin/content/'+id,url='/api/v1/public/content/article/'+locale+'/'+input.slug;assert.deepEqual(created.json().publication,{live:null,everPublished:false,hasUnpublishedChanges:true,scheduledAt:null,scheduledRevision:null});
  const review=async(expectedRevision:number)=>app.inject({method:'POST',url:base+'/review',headers:ownerH,payload:{expectedRevision,verdict:'approved',note:'Synthetic locale-specific publication approval.'}});
  assert.equal((await review(1)).statusCode,200);assert.equal((await app.inject({method:'PATCH',url:base,headers:ownerH,payload:{...input,state:'published',revision:2}})).statusCode,200);
  const replacement={...input,title:'Scheduled '+locale+' replacement',metadata:{...input.metadata,category:'Scheduled '+locale}};
  assert.equal((await app.inject({method:'PATCH',url:base,headers:editorH,payload:{...replacement,revision:3}})).statusCode,200);assert.equal((await review(4)).statusCode,200);
  const schedule=await app.inject({method:'PATCH',url:base,headers:ownerH,payload:{...replacement,state:'published',revision:5,publishAt:new Date(Date.now()+86400000).toISOString()}});assert.equal(schedule.statusCode,200,schedule.body);assert.equal(schedule.json().publication.live.revision,3);assert.equal(schedule.json().publication.live.title,input.title);assert.equal(schedule.json().publication.scheduledRevision,6);assert.equal(schedule.json().publication.hasUnpublishedChanges,true);
  await transaction(c=>publishScheduledContent(c,id));assert.equal((await app.inject({url})).json().title,input.title);
  assert.ok((await app.inject({url:'/api/v1/admin/content?status=published&search='+encodeURIComponent(replacement.title),headers:ownerH})).json().items.some((row:{id:string})=>row.id===id));
  await db.query("UPDATE content SET publish_at=now()-interval '1 second' WHERE id=$1",[id]);await transaction(c=>publishScheduledContent(c,id));assert.equal((await app.inject({url})).json().title,replacement.title);const protectedLive=(await app.inject({url:'/api/v1/admin/content?search='+encodeURIComponent(replacement.title),headers:ownerH}));assert.equal(protectedLive.statusCode,200);const current=protectedLive.json().items.find((item:{id:string})=>item.id===id);assert.equal(current.publication.live.revision,7);assert.equal(current.publication.hasUnpublishedChanges,false);
  const original=(await db.query('SELECT id FROM revisions WHERE content_id=$1 ORDER BY id LIMIT 1',[id])).rows[0].id;const restored=await app.inject({method:'POST',url:base+'/restore',headers:editorH,payload:{revisionId:Number(original),currentRevision:7}});assert.equal(restored.statusCode,200,restored.body);assert.equal(restored.json().locale,locale);assert.equal(restored.json().state,'draft');assert.equal((await app.inject({url})).json().title,replacement.title);
 }
});


test('Isolated restore quarantine clears scheduled and snapshot publication on new and older schemas',async()=>{
 const {execFileSync}=await import('node:child_process');const sql=execFileSync('python3',['-c',"import importlib.util; s=importlib.util.spec_from_file_location('lockdown','../scripts/release/restore_lockdown.py'); m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.PUBLICATION_SQL)"],{encoding:'utf8'});
 const connection=await db.connect();await connection.query('BEGIN');
 try{
  const id=randomUUID();await connection.query("INSERT INTO content(id,kind,slug,locale,title,body,state,publish_at) VALUES($1,'article',$2,'en','Synthetic restored publication','Restore fixture only','published',now()-interval '1 second')",[id,'restore-publication-'+id]);await connection.query("UPDATE content c SET published_snapshot=to_jsonb(c)-'published_snapshot' WHERE id=$1",[id]);
  assert.ok((await connection.query('SELECT id FROM published_content WHERE id=$1',[id])).rowCount);await connection.query(sql);assert.equal((await connection.query('SELECT id FROM published_content')).rowCount,0);assert.deepEqual((await connection.query('SELECT state,publish_at,published_snapshot FROM content WHERE id=$1',[id])).rows[0],{state:'draft',publish_at:null,published_snapshot:null});
  await connection.query('DROP VIEW published_content');await connection.query('ALTER TABLE content DROP COLUMN published_snapshot CASCADE');await connection.query("UPDATE content SET state='published',publish_at=now()+interval '1 day' WHERE id=$1",[id]);await connection.query(sql);assert.deepEqual((await connection.query('SELECT state,publish_at FROM content WHERE id=$1',[id])).rows[0],{state:'draft',publish_at:null});
 }finally{await connection.query('ROLLBACK');connection.release();}
});
