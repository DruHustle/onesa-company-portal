// Local disposable PostgreSQL + loopback S3/SMTP protocol fixtures only.
// The mounted scanner receives only synthetic bytes. This creates no release
// record and establishes no hosted provider, source or authorization acceptance.
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {run as fixture,validate as fixturePlan,stagingHost} from './oracle_portal_worker_fixture.mjs';
let phase='validate_local_input',probeCode,probeCategory,probePhase,databaseCode;

async function syntheticScanner(){
 const sockets=new Set(),prefix=Buffer.from('zINSTREAM\0');
 const benign=Buffer.from('%PDF-1.7\nOnesa isolated worker qualification\n%%EOF');
 const eicar=Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
 const server=net.createServer(socket=>{
  sockets.add(socket);let buffer=Buffer.alloc(0),offset=0,parts=[],bytes=0,done=false;
  socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.setTimeout(5000,()=>socket.destroy());
  socket.on('data',chunk=>{
   if(done)return socket.destroy();buffer=Buffer.concat([buffer,chunk]);
   if(buffer.length>32768)return socket.destroy();
   if(!offset){if(buffer.length<prefix.length)return;if(!buffer.subarray(0,prefix.length).equals(prefix))return socket.destroy();offset=prefix.length;}
   while(buffer.length>=offset+4){
    const length=buffer.readUInt32BE(offset);if(length>16384)return socket.destroy();
    if(buffer.length<offset+4+length)return;offset+=4;
    if(!length){
     done=true;const data=Buffer.concat(parts);
     const response=data.equals(benign)?'stream: OK\0':data.equals(eicar)?'stream: Eicar-Test-Signature FOUND\0':'stream: Synthetic fixture input refused ERROR\0';
     socket.end(response);return;
    }
    bytes+=length;if(bytes>16384)return socket.destroy();parts.push(buffer.subarray(offset,offset+length));offset+=length;
   }
  });
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen('/run/onesa-scanner/clamd.sock',resolve);});
 await writeFile('/run/onesa-scanner/scanner-ready',String(Math.floor(Date.now()/1000)),{mode:0o600,flag:'wx'});
 return {async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}

async function main(){
 const chunks=[];let size=0;
 for await(const chunk of process.stdin){size+=chunk.length;assert.ok(size<16384);chunks.push(chunk);}
 const input=JSON.parse(Buffer.concat(chunks));
 assert.equal(input.scope,'LOCAL_DISPOSABLE_WORKER_WORKFLOWS_ONLY');
 assert.ok(input.synthetic_scanner===undefined||typeof input.synthetic_scanner==='boolean');
 assert.ok(input.production_adapter===undefined||typeof input.production_adapter==='boolean');
 const uri=new URL(input.owner_uri);
 assert.equal(uri.hostname,stagingHost);assert.equal(uri.username,'neondb_owner');
 assert.match(uri.password,/^onesa_local_test_[a-f0-9]{48}$/);
 assert.equal(process.getuid(),1000);
 const cert=await readFile('/private/tls/cert.pem'),key=await readFile('/private/tls/key.pem');
 const request={action:'provision',owner_uri:uri.href,context_id:randomUUID(),fixture_id:randomUUID(),source:'a'.repeat(40),runtime_password:randomBytes(40).toString('base64url'),expires_at:new Date(Date.now()+1800000).toISOString()};
 const plan=fixturePlan(request),objects=new Map(),counts={put:0,get:0,delete:0};
 const access='ONESA_LOCAL_TEST_'+randomBytes(16).toString('hex');
 let server,scanner,provisioned=false;
 try{
  phase='provision_disposable_database';
  const ready=await fixture(request);provisioned=true;
  assert.equal(ready.state,'OWNED_STAGING_FIXTURE_PROVISIONED_NOT_AUTHORIZATION');
  if(input.synthetic_scanner)scanner=await syntheticScanner();
  phase='start_loopback_object_protocol';
  server=https.createServer({cert,key},async(req,res)=>{
   try{
    const auth=req.headers.authorization||'';
    assert.ok(auth.startsWith('AWS4-HMAC-SHA256 Credential='+access+'/'));
    const match=/^\/onesa-worker-fixture-test\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.exec((req.url||'').split('?')[0]);
    assert.ok(match);const id=match[1];
    assert.ok(counts.put+counts.get+counts.delete<100);
    res.setHeader('x-amz-request-id',randomUUID());
    if(req.method==='PUT'){
     if(req.headers['if-none-match'])assert.equal(req.headers['if-none-match'],'*');
     if(req.headers['if-none-match']==='*'&&objects.has(id)){res.writeHead(412,{'content-type':'application/xml'}).end('<Error><Code>PreconditionFailed</Code></Error>');return;}
     assert.ok(!objects.has(id));const chunks=[];let bytes=0;
     for await(const chunk of req){bytes+=chunk.length;assert.ok(bytes<=16384);chunks.push(chunk);}
     objects.set(id,Buffer.concat(chunks));counts.put++;res.writeHead(200).end();
    }else if(req.method==='GET'){
     counts.get++;
     if(objects.has(id)){res.writeHead(200,{'content-type':'application/octet-stream'}).end(objects.get(id));}
     else res.writeHead(404,{'content-type':'application/xml'}).end('<Error><Code>NoSuchKey</Code><Message>Disposable fixture key absent</Message></Error>');
    }else if(req.method==='HEAD'){res.writeHead(objects.has(id)?200:404).end();}
    else if(req.method==='DELETE'){counts.delete++;objects.delete(id);res.writeHead(204).end();}
    else res.writeHead(405).end();
   }catch{res.writeHead(400).end();}
  });
  server.requestTimeout=5000;server.headersTimeout=5000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const database=new URL(uri);database.username=plan.runtime;database.password=request.runtime_password;database.pathname='/'+plan.database;
  const values={NODE_ENV:'production',PUBLISH_ENABLED:'false',SESSION_KEY:randomBytes(48).toString('hex'),PROXY_SHARED_KEY:randomBytes(32).toString('hex'),PUBLIC_ORIGIN:'https://portal-worker-fixture.invalid',DATABASE_URL:database.href,S3_ENDPOINT:'https://fixture-storage.invalid:'+server.address().port+'/',S3_REGION:'us-east-1',S3_BUCKET:'onesa-worker-fixture-test',AWS_ACCESS_KEY_ID:access,AWS_SECRET_ACCESS_KEY:randomBytes(32).toString('hex'),CLAMAV_SOCKET:'/run/onesa-scanner/clamd.sock',WORKER_PROFILE:'staging',WORKER_IDLE_MAX_MS:'600000',MAIL_PROVIDER:'smtp',SMTP_HOST:'127.0.0.1',SMTP_PORT:'2525',MAIL_FROM:'qualification@example.invalid',NODE_EXTRA_CA_CERTS:'/private/tls/cert.pem'};
  const raw=Object.entries(values).map(([name,value])=>name+'='+value+'\n').join('');await writeFile('/private/runtime.env',raw,{mode:0o600,flag:'wx'});
  const digest=value=>createHash('sha256').update(value).digest('hex');
  const operation={binding:{repository:'DruHustle/onesa-company-portal',component:'worker',candidate_commit:request.source,source_tree:'b'.repeat(40),source_sha256:'c'.repeat(64),build_sha256:'d'.repeat(64),artifact_digest:'sha256:'+'e'.repeat(64),configuration_sha256:{staging:digest(raw),production:'f'.repeat(64)},target_environment:'production'},operation_id:request.context_id,fixture_id:request.fixture_id,environment:'staging',ci_run_id:1,expires_at:request.expires_at,runtime_sha256:digest(raw),certificate_sha256:digest(cert),rollback:{source:'f'.repeat(40),artifact_digest:'sha256:'+'f'.repeat(64)}};
  // Deliberately synthetic binding and CI number above are parser-test inputs,
  // never a fabricated Actions run, signed context or release receipt.
  const command=fileURLToPath(new URL('./oracle_portal_worker_probe.mjs',import.meta.url));
  phase='run_actual_worker_probe';
  const child=spawn(process.execPath,[command],{cwd:'/app',env:{PATH:process.env.PATH,NODE_OPTIONS:process.env.NODE_OPTIONS,...values},stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',value=>{out+=value;assert.ok(out.length<65536);});child.stderr.on('data',value=>{err+=value;assert.ok(err.length<65536);});
  const finished=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  const timer=setTimeout(()=>child.kill('SIGTERM'),240000);
  child.stdin.end(JSON.stringify(operation));const ended=await finished;clearTimeout(timer);
  if(ended.code!==0){
   try{
    const value=JSON.parse(out);
    if(/^(?:WORKER_|OWNED_DATABASE_|EMPTY_STAGING_)[A-Z_]{1,100}$/.test(value.error_code||''))probeCode=value.error_code;
    if(['Error','TypeError','RangeError','ReferenceError','SyntaxError','HttpError','ZodError','error'].includes(value.error_category))probeCategory=value.error_category;
    if(/^[a-z_]{1,80}$/.test(value.phase||''))probePhase=value.phase;
    if(/^[0-9]{2}[0-9A-Z]{3}$/.test(value.database_code||''))databaseCode=value.database_code;
   }catch{/* no raw private diagnostics */}
  }
  assert.equal(ended.code,0);assert.equal(ended.signal,null);assert.equal(err,'');
  phase='check_observed_results';
  const observed=JSON.parse(out);assert.equal(observed.state,'OWNED_STAGING_WORKER_OBSERVATIONS_NOT_AUTHORIZATION');
  assert.ok(Object.keys(observed.checks).length>=17);assert.ok(Object.values(observed.checks).every(value=>value===true));
  assert.equal(observed.existing_application_databases_changed,false);assert.equal(observed.global_tick_imported,false);assert.equal(observed.inbox_delivery_verified,false);
  assert.equal(objects.size,0);assert.equal(counts.put,3);assert.ok(counts.get>=7);assert.ok(counts.delete>=3);
  let productionChecks;
  if(input.production_adapter){
   phase='production_adapter_internal_process_fixture';
   assert.equal(input.synthetic_scanner,true);
   const {runLocal}=await import('./oracle_portal_worker_production.integration.mjs');
   productionChecks=await runLocal({owner_uri:uri.href,values,objects,counts,stageRequest:operation,stageRaw:raw});
   assert.ok(Object.values(productionChecks).every(value=>value===true));
   assert.equal(objects.size,0);
  }
  console.log(JSON.stringify({state:'LOCAL_WORKER_PROCESS_WORKFLOWS_PASS_NOT_HOSTED_QUALIFICATION',checks:observed.checks,production_adapter_checks:productionChecks,object_protocol_requests:counts,postgres_tls_verified:true,smtp_tls_acceptance_verified:true,inbox_delivery_verified:false,external_storage_provider_verified:false,synthetic_scanner_protocol:input.synthetic_scanner===true,hosted_scanner_qualification_claimed:false,production_access:false,synthetic_binding_only:true,release_records_issued:0}));
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  if(scanner)await scanner.close();
  if(provisioned)assert.equal((await fixture({...request,action:'cleanup'})).state,'OWNED_STAGING_FIXTURE_REMOVED');
 }
}
main().catch(error=>{console.error(JSON.stringify({state:'LOCAL_WORKER_PROCESS_WORKFLOWS_FAILED_NOT_QUALIFIED',phase,probe_code:probeCode,probe_category:probeCategory,probe_phase:probePhase,category:error?.name||'Error',database_code:databaseCode||(/^[0-9A-Z]{5}$/.test(error?.code||'')?error.code:undefined)}));process.exitCode=1;});
