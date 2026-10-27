// Exercise the real pinned CLI's prebuilt client offline, with no provider token.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const crypto=require('node:crypto'),assert=require('node:assert/strict');
async function fixture(mode){
 const environment=process.argv[4];assert.ok(['staging','production'].includes(environment));
 const cli='/opt/onesa-vercel-tool/node_modules/vercel';
 assert.equal(JSON.parse(fs.readFileSync(path.join(cli,'package.json'))).version,'65.2.0');
 const chunks=path.join(cli,'dist/chunks');
 const entries=fs.readdirSync(chunks).filter(n=>n.endsWith('.js')&&fs.readFileSync(path.join(chunks,n),'utf8').includes('"../client/dist/create-deployment.js"'));
 assert.equal(entries.length,1);
 const {require_dist}=await import('file://'+path.join(chunks,entries[0]));
 const {createDeployment}=require_dist();
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'onesa-real-client-'));fs.chmodSync(directory,0o700);
 const transport=path.join(directory,'transport'),workspace=path.join(directory,'workspace');fs.mkdirSync(transport,{mode:0o700});
 fs.mkdirSync(path.join(workspace,'.vercel/output/static'),{recursive:true});
 fs.writeFileSync(path.join(workspace,'.vercel/output/config.json'),'{"version":3}');
 fs.writeFileSync(path.join(workspace,'.vercel/output/static/owned.js'),'console.log("credential-free protocol fixture");');
 fs.writeFileSync(path.join(transport,'scope.json'),JSON.stringify({request_budget:1,operation_id:crypto.randomUUID(),repository:'DruHustle/onesa-company-portal',component:'frontend',environment}),{mode:0o600});
 const uploaded=new Set();let posts=0,created=0,uploads=0;const errors=[];
 const server=http.createServer(async(req,res)=>{
  if(process.env.ONESA_PROTOCOL_DIAGNOSTICS==='1')process.stderr.write(req.method+' '+req.url.split('?')[0]+'\n');
  try{
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);
   if(req.method==='POST'&&req.url.startsWith('/v2/files')){
    assert.equal(crypto.createHash('sha1').update(bytes).digest('hex'),req.headers['x-now-digest']);uploaded.add(req.headers['x-now-digest']);uploads++;res.writeHead(200);res.end('{}');return;
   }
   assert.equal(req.method,'POST');assert.ok(req.url.startsWith('/v13/deployments'));posts++;
   const body=JSON.parse(bytes);assert.ok(body.files.length);assert.equal(body.target,environment==='production'?'production':undefined);const missing=body.files.map(f=>f.sha).filter(sha=>!uploaded.has(sha));
   if(mode==='cold'&&missing.length){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'missing_files',missing}}));return;}
   created++;assert.equal(created,1);res.writeHead(201,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'dpl_fixture',readyState:'READY',aliasAssigned:true,url:'fixture.invalid'}));
  }catch(e){errors.push(e.message);res.writeHead(500);res.end('{}');}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 require('./oracle_vercel_transport_guard.cjs').install(transport,origin);
 try{
  const events=[];for await(const event of createDeployment({path:workspace,vercelOutputDir:path.join(workspace,'.vercel/output'),prebuilt:true,token:'synthetic-loopback-only',apiUrl:origin},{name:'onesa-protocol-fixture',...(environment==='production'?{target:'production'}:{})})){
   if(event.type==='error')throw Error('Pinned client failed: '+event.payload.code);events.push(event.type);
  }
  assert.deepEqual(errors,[]);assert.equal(created,1);assert.equal(posts,mode==='cold'?2:1);assert.equal(uploads>0,mode==='cold');assert.ok(events.includes('alias-assigned'));
  assert.equal(fs.existsSync(path.join(transport,'missing-files-response.json')),mode==='cold');assert.equal(fs.existsSync(path.join(transport,'create-continuation-request.json')),mode==='cold');
  console.log(JSON.stringify({cli:'65.2.0',mode,environment,deployment_post_requests:posts,actual_creates:created,file_uploads:uploads,network:'loopback-only',provider_credentials:false}));
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(directory,{recursive:true});}
}
async function fullCliFixture(mode){
 const environment=process.argv[4];assert.ok(['staging','production'].includes(environment));
 const {spawn}=require('node:child_process');
 const workspace='/fixture-workspaces/'+(mode==='missing-root'?'missing-root/':'')+environment;
 const cli='/opt/onesa-vercel-tool/node_modules/vercel/dist/index.js';
 const project=JSON.parse(fs.readFileSync(workspace+'/.vercel/project.json'));
 const directory=fs.mkdtempSync('/tmp/onesa-full-cli-'),transport=path.join(directory,'transport');fs.mkdirSync(transport,{mode:0o700});
 const operation=crypto.randomUUID();fs.writeFileSync(path.join(transport,'scope.json'),JSON.stringify({request_budget:1,operation_id:operation,repository:'DruHustle/onesa-company-portal',component:'frontend',environment}),{mode:0o600});
 const before=Object.fromEntries(['auth.json','config.json'].map(name=>[name,fs.readFileSync('/private/creds/'+name)]));
 let posts=0,created=0,uploads=0,regions=null;const uploaded=new Set(),errors=[];
 const team={id:project.orgId,slug:'fixture-team',name:'Synthetic loopback team',membership:{role:'OWNER'},billing:{plan:'hobby'}};
 const deployment={id:'dpl_fixture',uid:'dpl_fixture',projectId:project.projectId,readyState:'READY',aliasAssigned:true,url:'fixture.invalid',createdAt:Date.now(),alias:[],target:environment==='production'?'production':null};
 function send(res,data,status=200){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));}
 const server=http.createServer(async(req,res)=>{if(process.env.ONESA_PROTOCOL_DIAGNOSTICS==='1')process.stderr.write(req.method+' '+req.url.split('?')[0]+'\n');try{
  const url=new URL(req.url,'http://fixture'),chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);
  if(req.method==='POST'&&url.pathname.startsWith('/v2/files')){const sha=crypto.createHash('sha1').update(bytes).digest('hex');assert.equal(sha,req.headers['x-now-digest']);uploaded.add(sha);uploads++;return send(res,{});}
  if(req.method==='POST'&&/\/v[0-9]+\/deployments$/.test(url.pathname)){
   posts++;const body=JSON.parse(bytes);regions=body.regions;assert.equal(body.env.BACKEND_URL,environment==='production'?'https://portal-api.onesa.eu':'https://portal-api-staging.onesa.eu');if(environment==='staging'){assert.equal(body.env.PROXY_SHARED_KEY,'synthetic-loopback-proxy-'.repeat(2));assert.equal(body.env.ACCESS_REGISTRATION_ENABLED,'false');assert.equal(body.env.ENGINEERING_SIGNIN_ENABLED,'true');assert.equal(body.env.ENGINEERING_ACCESS_CALLBACK_URL,'https://fixture.invalid/callback');}else assert.equal(body.env.PROXY_SHARED_KEY,undefined);assert.equal(body.meta.githubCommitSha,'a'.repeat(40));assert.equal(body.meta.onesaOracleOperation,operation);
   assert.ok(environment==='production'?body.target==='production':[undefined,'preview'].includes(body.target));
   const missing=body.files.filter(f=>f.sha&&!uploaded.has(f.sha)).map(f=>f.sha);
   if(mode==='cold'&&missing.length)return send(res,{error:{code:'missing_files',missing}},400);
   created++;assert.equal(created,1);return send(res,deployment,201);
  }
  if(req.method==='GET'&&url.pathname==='/v2/user')return send(res,{user:{id:'user_fixture',username:'synthetic-fixture',email:'fixture@example.com'}});
  if(req.method==='GET'&&url.pathname.startsWith('/v9/projects/'))return send(res,{id:project.projectId,name:project.projectName,accountId:project.orgId,rootDirectory:'onesa-company-portal-frontend',framework:'nextjs',nodeVersion:'24.x',directoryListing:false,autoExposeSystemEnvs:true,latestDeployments:[],targets:{}});
  if(req.method==='GET'&&url.pathname==='/v2/teams')return send(res,{teams:[team],pagination:{count:1,next:null,prev:null}});
  if(req.method==='GET'&&url.pathname.startsWith('/v2/teams/'))return send(res,team);
  if(req.method==='GET'&&url.pathname.startsWith('/v13/deployments/'))return send(res,deployment);
  throw Error('Unexpected synthetic provider route: '+req.method+' '+url.pathname);
 }catch(e){errors.push(e.message);send(res,{error:{code:'fixture_error',message:e.message}},500);}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const origin='http://127.0.0.1:'+server.address().port,preload=path.join(directory,'preload.cjs');fs.writeFileSync(preload,'require("/tests/oracle_vercel_transport_guard.cjs").install('+JSON.stringify(transport)+','+JSON.stringify(origin)+');',{mode:0o600});
  const bootstrap=fs.readFileSync(path.join(__dirname,'oracle_portal_frontend.py'),'utf8').match(/CLI_BOOTSTRAP = r"""([\s\S]*?)"""/)[1];
  const args=['-e',bootstrap,'--','--require',preload,cli,'deploy','--prebuilt','--yes','--no-wait','--json','--global-config','/tmp/onesa-vercel-cli','--project',project.projectId,'--env','BACKEND_URL='+ (environment==='production'?'https://portal-api.onesa.eu':'https://portal-api-staging.onesa.eu'),...(environment==='staging'?['--env','PROXY_SHARED_KEY','--env','ACCESS_REGISTRATION_ENABLED=false','--env','ENGINEERING_SIGNIN_ENABLED=true','--env','ENGINEERING_ACCESS_CALLBACK_URL=https://fixture.invalid/callback']:[]),'--api',origin,'--meta','githubCommitSha='+'a'.repeat(40),'--meta','onesaOracleOperation='+operation,...(environment==='production'?['--prod']:[])];
  const result=await new Promise(resolve=>{
   const child=spawn(process.execPath,args,{cwd:workspace,env:{PATH:process.env.PATH,HOME:'/tmp',PROXY_SHARED_KEY:'synthetic-loopback-proxy-'.repeat(2)},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
   const timer=setTimeout(()=>child.kill('SIGTERM'),25000);child.once('error',e=>{clearTimeout(timer);resolve({code:null,stderr:e.message,stdout});});child.once('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
  });
  assert.deepEqual(errors,[]);
  for(const [name,bytes]of Object.entries(before))assert.deepEqual(fs.readFileSync('/private/creds/'+name),bytes);
  if(mode==='missing-root'){
   assert.equal(result.code,1);assert.match(result.stderr,/provided path.*does not exist/s);assert.equal(created,0);assert.equal(posts,0);assert.equal(fs.existsSync(path.join(transport,'create-request.json')),false);
  }else{
   assert.equal(result.code,0,result.stderr);assert.equal(created,1);assert.equal(posts,mode==='cold'?2:1);assert.equal(uploads>0,mode==='cold');
   if(environment==='production')assert.deepEqual(regions,['fra1']);
   assert.ok(fs.existsSync(path.join(transport,'create-request.json')));assert.equal(fs.existsSync(path.join(transport,'missing-files-response.json')),mode==='cold');
  }
  console.log(JSON.stringify({cli:'65.2.0',full_cli:true,mode,environment,deployment_post_requests:posts,actual_creates:created,file_uploads:uploads,network:'loopback-only',provider_credentials:false,master_custody_preserved:true}));
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync('/tmp/onesa-vercel-cli',{recursive:true,force:true});fs.rmSync(directory,{recursive:true});}
}
if(process.argv[2]==='--cli-fixture')fullCliFixture(process.argv[3]).catch(e=>{console.error(e);process.exit(1)});
else if(process.argv[2]==='--fixture')fixture(process.argv[3]).catch(e=>{console.error(e);process.exit(1)});
else{
 const test=require('node:test'),{execFile}=require('node:child_process');
 for(const environment of ['staging','production'])for(const mode of ['cold','warm','missing-root'])test(`full pinned deploy CLI ${environment} ${mode} project resolution and request budget`,{timeout:35000},async()=>{
  const result=await new Promise((resolve,reject)=>execFile(process.execPath,[__filename,'--cli-fixture',mode,environment],{timeout:30000,env:{PATH:process.env.PATH,HOME:'/tmp'}},(error,stdout,stderr)=>error?reject(Error(stderr||error.message)):resolve(JSON.parse(stdout))));
  assert.equal(result.actual_creates,mode==='missing-root'?0:1);assert.equal(result.provider_credentials,false);assert.equal(result.master_custody_preserved,true);
 });
 for(const environment of ['staging','production'])test(`full pinned CLI ${environment} starts with read-only owner custody`,{timeout:30000},async()=>{
  const bootstrap=fs.readFileSync(path.join(__dirname,'oracle_portal_frontend.py'),'utf8').match(/CLI_BOOTSTRAP = r"""([\s\S]*?)"""/)[1];
  const before=Object.fromEntries(['auth.json','config.json'].map(name=>[name,fs.readFileSync('/private/creds/'+name)]));
  const transport='/private/transport';fs.mkdirSync(transport,{mode:0o700,recursive:true});
  fs.writeFileSync(path.join(transport,'scope.json'),JSON.stringify({request_budget:1,operation_id:crypto.randomUUID(),repository:'DruHustle/onesa-company-portal',component:'frontend',environment}),{mode:0o600});
  assert.equal(fs.existsSync('/tmp/onesa-vercel-cli'),false);
  try {
   const args=['-e',bootstrap,'--','--require','/private/guard.cjs','/opt/onesa-vercel-tool/node_modules/vercel/dist/index.js','deploy','--prebuilt','--yes','--no-wait','--json','--global-config','/tmp/onesa-vercel-cli','--project','prj_fixture','--meta','githubCommitRef='+ (environment==='production'?'main':'staging'),...(environment==='production'?['--prod']:[]),'--help'];
   const result=await new Promise((resolve,reject)=>execFile(process.execPath,args,{timeout:25000,env:{PATH:process.env.PATH,HOME:'/tmp',ONESA_ORACLE_VERIFIER_PRELOAD:'1'}},(error,stdout,stderr)=>error?reject(Error(stderr||error.message)):resolve({stdout,stderr})));
   assert.match(result.stdout+result.stderr,/Deploy your project to Vercel/);
   assert.doesNotMatch(result.stdout+result.stderr,/EROFS|EACCES|unexpected error/i);
   for(const [name,bytes]of Object.entries(before))assert.deepEqual(fs.readFileSync('/private/creds/'+name),bytes);
   assert.equal(fs.existsSync(path.join(transport,'create-request.json')),false);
  } finally {fs.rmSync('/tmp/onesa-vercel-cli',{recursive:true,force:true});}
 });
 for(const environment of ['staging','production'])for(const mode of ['cold','warm'])test(`pinned prebuilt client ${environment} ${mode} cache creates exactly one deployment`,{timeout:30000},async()=>{
  const result=await new Promise((resolve,reject)=>execFile(process.execPath,[__filename,'--fixture',mode,environment],{timeout:25000,env:{PATH:process.env.PATH,HOME:'/tmp'}},(error,stdout,stderr)=>error?reject(Error(stderr||error.message)):resolve(JSON.parse(stdout))));
  assert.equal(result.actual_creates,1);assert.equal(result.provider_credentials,false);assert.equal(result.environment,environment);
 });
}
