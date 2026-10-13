// Executed on the owner recovery host. No dependency on the Oracle VM or its keys.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3';
const x=JSON.parse(fs.readFileSync(0,'utf8'));
const require=value=>{if(!value)throw Error('Private recovery guard rejected');};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
try{
 require(new URL(x.endpoint).hostname==='br-red-morning-b9d1sxnz.storage.c-7.eu-central-1.aws.neon.tech');
 require(/^\.onesa-portal-backups\/v1\/[a-f0-9]{32}\.json$/.test(x.object_key)&&/^[a-f0-9]{64}$/.test(x.key_id));
 const s3=new S3Client({endpoint:x.endpoint,region:x.region,forcePathStyle:true,credentials:{accessKeyId:x.access,secretAccessKey:x.secret}});
 const get=async key=>{const r=await s3.send(new GetObjectCommand({Bucket:x.bucket,Key:key}));require(Number(r.ContentLength)<128*1024*1024);return Buffer.from(await r.Body.transformToByteArray());};
 const escrow=await get('.onesa-portal-backups/v1/keys/'+x.key_id+'.enc');
 const decrypt=(key,nonce,tag,body,aad)=>{const d=crypto.createDecipheriv('aes-256-gcm',key,nonce);if(aad)d.setAAD(aad);d.setAuthTag(tag);return Buffer.concat([d.update(body),d.final()]);};
 const privateKey=decrypt(Buffer.from(x.master,'base64'),escrow.subarray(0,12),escrow.subarray(12,28),escrow.subarray(28));
 const publicKey=crypto.createPublicKey(privateKey).export({type:'spki',format:'pem'});require(hash(publicKey)===x.key_id);
 const archive=await get(x.object_key);require(hash(archive)===x.ciphertext_sha256);
 const sealed=JSON.parse(archive);require(sealed.meta.format==='onesa-portal-backup-v1'&&sealed.meta.key_id===x.key_id);
 const key=crypto.privateDecrypt({key:privateKey,oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(sealed.wrapped_key,'base64'));
 const nonce=Buffer.from(sealed.nonce,'base64'),tag=Buffer.from(sealed.tag,'base64'),body=Buffer.from(sealed.body,'base64'),aad=Buffer.from(JSON.stringify(sealed.meta));
 const opened=decrypt(key,nonce,tag,body,aad);const payload=JSON.parse(opened);
 require(hash(Buffer.from(payload.dump,'base64'))===sealed.meta.database_sha256);
 for(const file of payload.objects){const bytes=Buffer.from(file.bytes,'base64');require(bytes.length===file.size&&hash(bytes)===file.sha256);}
 const changed=Buffer.from(body);changed[0]^=1;let rejected=false;try{decrypt(key,nonce,tag,changed,aad);}catch{rejected=true;}require(rejected);
 require(payload.objects.length===sealed.meta.objects&&typeof payload.session_key==='string'&&payload.session_key.length>=48);
 fs.writeFileSync(1,JSON.stringify({...payload,checks:{key_recovered_from_off_instance_escrow:true,original_private_key_file_not_used:true,ciphertext_integrity_verified:true,tampered_archive_rejected:true,object_count:payload.objects.length}}));
}catch{console.error('Independent backup recovery rejected; private diagnostics required');process.exitCode=1;}
