import './local-environment.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isolateLocalTestEnvironment} from './local-environment.js';
import {assertTestStorageScope} from '../src/services/storage-scope.js';
import {spawnSync} from 'node:child_process';
test('Local test fixtures erase inherited cloud, scanner and email bindings before runtime imports',()=>{
 const config={TEST_DATABASE_URL:'postgresql://synthetic:synthetic@127.0.0.1:55440/onesa_portal_test',DATABASE_URL:'postgresql://fixture:fixture@production.example.invalid/live',S3_BUCKET:'live-bucket',AWS_ENDPOINT_URL_S3:'https://live.example.invalid',AWS_ACCESS_KEY_ID:'synthetic-inherited-key',AWS_SECRET_ACCESS_KEY:'synthetic-inherited-secret',CLAMAV_SOCKET:'/etc/private/clamd.sock',CLAMAV_HOST:'scanner.example.invalid',SMTP_HOST:'mail.example.invalid',SMTP_PASSWORD:'synthetic-inherited-password',RESEND_API_KEY:'synthetic-inherited-key',MAIL_PROVIDER:'resend',NOTIFY_EMAIL:'recipient@example.invalid',RENDER:'true',PUBLICATION_STAGE:'prelaunch'};
 isolateLocalTestEnvironment(config);assert.equal(config.DATABASE_URL,config.TEST_DATABASE_URL);assert.equal(config.MAIL_PROVIDER,'smtp');
 for(const key of ['S3_BUCKET','AWS_ENDPOINT_URL_S3','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','CLAMAV_SOCKET','CLAMAV_HOST','SMTP_HOST','SMTP_PASSWORD','RESEND_API_KEY','NOTIFY_EMAIL','RENDER','PUBLICATION_STAGE'])assert.equal(key in config,false,key);
});
test('Local fixtures reject a hosted test-name database and a non-test loopback target',()=>{
 for(const uri of ['postgresql://fixture:fixture@production.example.invalid/onesa_portal_test','postgresql://fixture:fixture@127.0.0.1/onesa_portal'])assert.throws(()=>isolateLocalTestEnvironment({TEST_DATABASE_URL:uri}),/reject hosted or non-test/);
});
test('Storage source guard rejects inherited cloud credentials with no explicit isolated endpoint',()=>{
 assert.throws(()=>assertTestStorageScope({NODE_ENV:'test'},{AWS_ACCESS_KEY_ID:'synthetic-inherited-key',AWS_SECRET_ACCESS_KEY:'synthetic-inherited-secret'}),/Test storage target refused/);
 assert.doesNotThrow(()=>assertTestStorageScope({NODE_ENV:'test',S3_ENDPOINT:'http://127.0.0.1:9000',S3_BUCKET:'onesa-isolated-test'},{AWS_ACCESS_KEY_ID:'synthetic-local-key'}));
 assert.throws(()=>assertTestStorageScope({NODE_ENV:'test',S3_ENDPOINT:'http://127.0.0.1:9000',S3_BUCKET:'onesa-production'}),/Test storage target refused/);
});
test('Unsanitized inherited production storage fails before client use or any write, including runtime overrides',()=>{
 const source=new URL('../src/services/storage.ts',import.meta.url).href,config=new URL('../src/config/env.ts',import.meta.url).href;
 const probe=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {S3Client} from '@aws-sdk/client-s3';let writes=0,sends=0;const write=fs.promises.writeFile;fs.promises.writeFile=async(path,...args)=>{if(String(path).startsWith('/tmp/onesa-source-storage-sentinel')){writes++;return;}return write(path,...args)};syncBuiltinESMExports();S3Client.prototype.send=async()=>{sends++;return {}};let rejected=false;try{const storage=await import(${JSON.stringify(source)});const {env}=await import(${JSON.stringify(config)});env.S3_BUCKET='onesa-production-sentinel';env.S3_ENDPOINT='https://production-storage.example.invalid';await storage.store('00000000-0000-0000-0000-000000000001',Buffer.from('synthetic'));}catch(error){rejected=/Test storage target refused/.test(error.message)}console.log(JSON.stringify({rejected,writes,sends}));`;
 const fixture={PATH:process.env.PATH,NODE_ENV:'test',DATABASE_URL:'postgresql://synthetic:synthetic@127.0.0.1:1/onesa_portal_test',SESSION_KEY:'synthetic-test-only-'+ 'x'.repeat(48),AWS_EC2_METADATA_DISABLED:'true',STORAGE_DIR:'/tmp/onesa-source-storage-sentinel'};
 for(const inherited of [{S3_BUCKET:'onesa-production-sentinel',AWS_ENDPOINT_URL_S3:'https://production-storage.example.invalid',AWS_ACCESS_KEY_ID:'synthetic-inherited-key',AWS_SECRET_ACCESS_KEY:'synthetic-inherited-secret'},{}]){
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',probe],{env:{...fixture,...inherited},encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{rejected:true,writes:0,sends:0});
 }
});
