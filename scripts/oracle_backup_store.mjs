// Private backup transport. stdin contains secrets/data; stdout is restricted evidence.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {S3Client,PutObjectCommand,GetObjectCommand,ListObjectsV2Command,DeleteObjectCommand} from '@aws-sdk/client-s3';
const MAX=64*1024*1024,PREFIX='.onesa-portal-backups/v1/';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const require=value=>{if(!value)throw Error('Backup safety check failed');};
const s3=new S3Client({endpoint:process.env.S3_ENDPOINT,region:process.env.S3_REGION,forcePathStyle:true});
const bucket=process.env.S3_BUCKET;
require(new URL(process.env.S3_ENDPOINT).hostname==='br-red-morning-b9d1sxnz.storage.c-7.eu-central-1.aws.neon.tech'&&bucket);
const get=async key=>{const r=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));require(Number(r.ContentLength)<=MAX*2);return Buffer.from(await r.Body.transformToByteArray());};
try{
 if(input.action==='backup'){
  require(/^[a-f0-9]{32}$/.test(input.id)&&Array.isArray(input.files)&&input.files.length<=1000);
  const dump=Buffer.from(input.dump,'base64');require(dump.subarray(0,5).toString()==='PGDMP'&&dump.length<MAX);
  const objects=[];let total=dump.length;
  for(const file of input.files){require(/^[a-f0-9-]{36}$/.test(file.storage_key));const bytes=await get(file.storage_key);require(bytes.length===file.size&&digest(bytes)===file.sha256);total+=bytes.length;require(total<MAX);objects.push({...file,bytes:bytes.toString('base64')});}
  const publicKey=fs.readFileSync('/recovery/public.pem'),keyId=digest(publicKey),key=crypto.randomBytes(32),nonce=crypto.randomBytes(12);
  const meta={format:'onesa-portal-backup-v1',id:input.id,key_id:keyId,created_at:new Date().toISOString(),database_sha256:digest(dump),objects:objects.length};
  const payload=Buffer.from(JSON.stringify({dump:input.dump,objects,manifest:input.manifest,session_key:process.env.SESSION_KEY}));require(payload.length<MAX*2);
  const cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(JSON.stringify(meta)));
  const sealed={meta,wrapped_key:crypto.publicEncrypt({key:publicKey,oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},key).toString('base64'),nonce:nonce.toString('base64'),tag:null,body:null};
  sealed.body=Buffer.concat([cipher.update(payload),cipher.final()]).toString('base64');sealed.tag=cipher.getAuthTag().toString('base64');
  const body=Buffer.from(JSON.stringify(sealed)),object=PREFIX+input.id+'.json';
  await s3.send(new PutObjectCommand({Bucket:bucket,Key:object,Body:body,ServerSideEncryption:'AES256',ContentType:'application/json'}));
  require(digest(await get(object))===digest(body));
  let token,listed=[],pages=0;do{const page=await s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:PREFIX,ContinuationToken:token}));listed.push(...(page.Contents||[]));token=page.NextContinuationToken;require(++pages<10);}while(token);
  let removed=0;for(const item of listed){if(new RegExp('^'+PREFIX.replaceAll('.','\\.')+'[a-f0-9]{32}\\.json$').test(item.Key)&&item.Key!==object&&item.LastModified&&Date.now()-item.LastModified.getTime()>7*86400000){await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:item.Key}));removed++;}}
  console.log(JSON.stringify({passed:true,id:input.id,object_key:object,ciphertext_sha256:digest(body),dump_sha256:digest(dump),object_count:objects.length,source_bytes:total,key_id:keyId,retention_days:7,expired_archives_removed:removed,off_instance_storage_verified:true}));
 }else if(input.action==='read'){
  require(new RegExp('^'+PREFIX.replaceAll('.','\\.')+'(?:[a-f0-9]{32}\\.json|keys/[a-f0-9]{64}\\.enc)$').test(input.key));fs.writeFileSync(1,await get(input.key));
 }else if(input.action==='escrow'){
  require(/^[a-f0-9]{64}$/.test(input.key_id));const bytes=Buffer.from(input.ciphertext,'base64');require(bytes.length>100&&bytes.length<16384);
  const object=PREFIX+'keys/'+input.key_id+'.enc';await s3.send(new PutObjectCommand({Bucket:bucket,Key:object,Body:bytes,ServerSideEncryption:'AES256'}));require(digest(await get(object))===digest(bytes));console.log(JSON.stringify({passed:true,escrow_object_key:object,key_id:input.key_id,ciphertext_sha256:digest(bytes)}));
 }else throw Error('Unsupported backup action');
}catch{console.error(JSON.stringify({event:'portal_backup_transport_failed'}));process.exitCode=1;}
